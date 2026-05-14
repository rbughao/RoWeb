'use strict';

/**
 * Tunnel Server — deploy this on a VPS with a public IP.
 *
 * Prerequisites:
 *   - Wildcard DNS:  *.yourdomain.com  →  VPS IP
 *   - TLS cert:      Let's Encrypt (certbot) or equivalent
 *   - Open ports:    80, 443, 7000  (or custom controlPort)
 *
 * Run:  node tunnel/server.js
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { TYPES, encode, FrameParser } = require('./protocol');

// ── Config ────────────────────────────────────────────────────────────────────

const configPath = path.join(__dirname, 'tunnel-config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`Failed to read tunnel-config.json: ${err.message}`);
  process.exit(1);
}

const srv = config.server || {};
const {
  domain,
  controlPort  = 7000,
  token,
  certFile,
  keyFile,
  requestTimeout = 30000,
} = srv;

if (!domain)  { console.error('tunnel-config.json: server.domain is required');  process.exit(1); }
if (!token)   { console.error('tunnel-config.json: server.token is required');   process.exit(1); }
if (!certFile){ console.error('tunnel-config.json: server.certFile is required'); process.exit(1); }
if (!keyFile) { console.error('tunnel-config.json: server.keyFile is required');  process.exit(1); }

let cert, key;
try {
  cert = fs.readFileSync(certFile);
  key  = fs.readFileSync(keyFile);
} catch (err) {
  console.error(`Failed to read TLS cert/key: ${err.message}`);
  process.exit(1);
}

// ── Tunnel registry ───────────────────────────────────────────────────────────

// subdomain (string) → { socket, parser, pending: Map<requestId, {resolve, reject, timer}> }
const tunnels = new Map();

// Monotonically increasing request IDs per server instance (wraps at 2^32)
let nextReqId = 1;
function newReqId() {
  const id = nextReqId;
  nextReqId = (nextReqId + 1) >>> 0 || 1; // keep in uint32 range, skip 0
  return id;
}

function assignSubdomain(preferred) {
  const candidate = (preferred || '').replace(/[^a-z0-9-]/gi, '').slice(0, 32);
  if (candidate && !tunnels.has(candidate)) return candidate;
  let sub;
  do { sub = crypto.randomBytes(4).toString('hex'); } while (tunnels.has(sub));
  return sub;
}

// ── Control server (accepts tunnel client connections) ────────────────────────

const controlServer = http.createServer((_req, res) => {
  res.writeHead(400, { 'Content-Type': 'text/plain' });
  res.end('Use HTTP Upgrade for tunnel connections.');
});

controlServer.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());

  if (req.headers['upgrade'] !== 'roweb-tunnel') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    return socket.destroy();
  }
  if (req.headers['x-token'] !== token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }

  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: roweb-tunnel\r\nConnection: Upgrade\r\n\r\n');

  const parser  = new FrameParser();
  const pending = new Map(); // requestId → { resolve, reject, timer }
  let subdomain = null;

  if (head.length > 0) parser.push(head);
  socket.on('data', chunk => parser.push(chunk));

  parser.on('frame', ({ type, requestId, payload }) => {
    switch (type) {

      case TYPES.HELLO: {
        subdomain = assignSubdomain(payload.subdomain);
        const publicUrl = `https://${subdomain}.${domain}`;
        tunnels.set(subdomain, { socket, parser, pending });
        socket.write(encode(TYPES.HELLO_ACK, 0, { subdomain, publicUrl }));
        console.log(`[+] ${publicUrl}  (port ${payload.localPort})`);
        break;
      }

      case TYPES.HTTP_RES: {
        const waiter = pending.get(requestId);
        if (waiter) {
          pending.delete(requestId);
          clearTimeout(waiter.timer);
          waiter.resolve(payload);
        }
        break;
      }

      case TYPES.PING:
        socket.write(encode(TYPES.PONG, 0, {}));
        break;

      case TYPES.PONG:
        break;

      case TYPES.ERROR:
        console.error(`[Tunnel error] ${subdomain}: ${payload.message}`);
        break;
    }
  });

  parser.on('error', err => {
    console.error(`[Parser error] ${subdomain}: ${err.message}`);
    socket.destroy();
  });

  socket.on('close', () => {
    if (subdomain) {
      tunnels.delete(subdomain);
      console.log(`[-] Disconnected: ${subdomain}.${domain}`);
    }
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Tunnel disconnected'));
    }
    pending.clear();
  });

  // Server-side heartbeat: send PING every 30s, drop socket if 2 misses
  let missedPings = 0;
  const heartbeat = setInterval(() => {
    if (++missedPings > 2) { clearInterval(heartbeat); return socket.destroy(); }
    socket.write(encode(TYPES.PING, 0, {}));
  }, 30_000);
  heartbeat.unref();

  // Reset miss counter on any PONG
  parser.on('frame', ({ type }) => { if (type === TYPES.PONG) missedPings = 0; });

  socket.on('close', () => clearInterval(heartbeat));
});

controlServer.listen(controlPort, () => {
  console.log(`Control server  :${controlPort}`);
});

// ── Public HTTPS server ───────────────────────────────────────────────────────

const publicServer = https.createServer({ cert, key }, (req, res) => {
  const host      = (req.headers['host'] || '').toLowerCase();
  const subdomain = host.split('.')[0];
  const tunnel    = tunnels.get(subdomain);

  if (!tunnel) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(
      `<!DOCTYPE html><html><head><title>No Tunnel</title></head><body>
       <h2>502 — No active tunnel</h2>
       <p>The tunnel for <code>${subdomain}</code> is not connected.</p>
       </body></html>`
    );
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body      = Buffer.concat(chunks).toString('base64');
    const requestId = newReqId();

    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        tunnel.pending.delete(requestId);
        reject(new Error('Upstream timeout'));
      }, requestTimeout);
      tunnel.pending.set(requestId, { resolve, reject, timer });
    });

    tunnel.socket.write(encode(TYPES.HTTP_REQ, requestId, {
      method:  req.method,
      path:    req.url,
      headers: req.headers,
      body,
    }));

    responsePromise
      .then(({ statusCode, headers, body: resBodyB64 }) => {
        const resBody = Buffer.from(resBodyB64 || '', 'base64');
        // Strip hop-by-hop headers
        const safe = Object.fromEntries(
          Object.entries(headers || {}).filter(([k]) =>
            !['connection', 'transfer-encoding', 'keep-alive', 'upgrade'].includes(k.toLowerCase())
          )
        );
        res.writeHead(statusCode, safe);
        res.end(resBody);
      })
      .catch(err => {
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'text/plain' });
          res.end(`504 Gateway Timeout: ${err.message}`);
        }
      });
  });

  req.on('error', () => {
    if (!res.headersSent) { res.writeHead(400); res.end(); }
  });
});

publicServer.listen(443, () => {
  console.log(`Public HTTPS    :443  (*.${domain})`);
});

// ── HTTP → HTTPS redirect ─────────────────────────────────────────────────────

http.createServer((req, res) => {
  const location = `https://${req.headers.host || domain}${req.url}`;
  res.writeHead(301, { Location: location });
  res.end();
}).listen(80, () => {
  console.log(`HTTP redirect   :80  → HTTPS`);
});

// ── Shutdown ──────────────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\nShutting down tunnel server...');
  for (const [, { socket }] of tunnels) socket.destroy();
  controlServer.close();
  publicServer.close();
  process.exit(0);
});

console.log(`\nTunnel server ready — domain: *.${domain}`);

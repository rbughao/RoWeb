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

const { TYPES, encode, FrameParser, stripHopByHop } = require('./protocol');

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
  controlPort  = 7000,
  token,
  certFile,
  keyFile,
  requestTimeout = 30000,
  maxBodyBytes   = 10 * 1024 * 1024,
  maxConcurrent  = 50,                  // in-flight public requests per tunnel
  maxFrameBytes  = 256 * 1024 * 1024,   // largest response a tunnel client may send back
} = srv;
// Control connections carry the token, visitors' logins and page content — encrypt by default
const controlTls = srv.controlTls !== false;
const domain = String(srv.domain || '').toLowerCase();

if (!domain) { console.error('tunnel-config.json: server.domain is required');  process.exit(1); }
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

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  const candidate = String(preferred || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
  if (candidate && !tunnels.has(candidate)) return candidate;
  let sub;
  do { sub = crypto.randomBytes(4).toString('hex'); } while (tunnels.has(sub));
  return sub;
}

// ── Control server (accepts tunnel client connections) ────────────────────────

const controlHandler = (_req, res) => {
  res.writeHead(400, { 'Content-Type': 'text/plain' });
  res.end('Use HTTP Upgrade for tunnel connections.');
};
const controlServer = controlTls
  ? https.createServer({ cert, key }, controlHandler)
  : http.createServer(controlHandler);
controlServer.headersTimeout = 10_000;

controlServer.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());

  if (req.headers['upgrade'] !== 'roweb-tunnel') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    return socket.destroy();
  }
  if (!safeEqual(req.headers['x-token'] || '', token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }

  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: roweb-tunnel\r\nConnection: Upgrade\r\n\r\n');

  const parser  = new FrameParser(maxFrameBytes);
  const pending = new Map(); // requestId → { resolve, reject, timer }
  let subdomain = null;

  if (head.length > 0) parser.push(head);
  socket.on('data', chunk => parser.push(chunk));

  parser.on('frame', ({ type, requestId, payload }) => {
    switch (type) {

      case TYPES.HELLO: {
        // One subdomain per connection; extra HELLOs would leave stale registrations behind
        if (subdomain) {
          socket.write(encode(TYPES.ERROR, 0, { message: 'Already registered on this connection.' }));
          break;
        }
        subdomain = assignSubdomain(payload.subdomain);
        const publicUrl = `https://${subdomain}.${domain}`;
        tunnels.set(subdomain, { socket, parser, pending, inflight: 0 });
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
  console.log(`Control server  :${controlPort}  (${controlTls ? 'TLS' : 'PLAIN TCP — token and traffic are unencrypted'})`);
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
       <p>The tunnel for <code>${escapeHtml(subdomain)}</code> is not connected.</p>
       </body></html>`
    );
  }

  const tooLarge = () => {
    res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end('413 Payload Too Large', () => req.socket.destroy());
  };

  if (parseInt(req.headers['content-length'] || '0', 10) > maxBodyBytes) return tooLarge();

  // Bound memory: each in-flight request may buffer up to maxBodyBytes
  if (tunnel.inflight >= maxConcurrent) {
    res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
    return res.end('503 Service Unavailable — too many concurrent requests for this tunnel.');
  }
  tunnel.inflight++;
  res.on('close', () => { tunnel.inflight--; });

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', chunk => {
    if (aborted) return;
    size += chunk.length;
    if (size > maxBodyBytes) { aborted = true; return tooLarge(); }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
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
      // Overwrite (never append) so clients can't spoof their IP to dodge rate limiting
      headers: {
        ...stripHopByHop(req.headers),
        'x-forwarded-for':   req.socket.remoteAddress || '',
        'x-forwarded-proto': 'https',
        'x-forwarded-host':  host,
      },
      body,
    }));

    responsePromise
      .then(({ statusCode, headers, body: resBodyB64 }) => {
        const resBody = Buffer.from(resBodyB64 || '', 'base64');
        const safe = stripHopByHop(headers, ['content-length']);
        safe['content-length'] = resBody.length;
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

publicServer.requestTimeout = requestTimeout + 10_000;
publicServer.headersTimeout = 10_000;

publicServer.listen(443, () => {
  console.log(`Public HTTPS    :443  (*.${domain})`);
});

// ── HTTP → HTTPS redirect ─────────────────────────────────────────────────────

// Only redirect to our own domain; an attacker-supplied Host header falls back to the bare domain
function redirectHost(hostHeader) {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  const ours = host === domain || host.endsWith('.' + domain);
  return ours && /^[a-z0-9.-]+$/.test(host) ? host : domain;
}

http.createServer((req, res) => {
  const reqPath  = (req.url || '/').startsWith('/') ? req.url : '/';
  const location = `https://${redirectHost(req.headers.host)}${reqPath}`;
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

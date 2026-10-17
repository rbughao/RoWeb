'use strict';

/**
 * Tunnel Client — runs on your local machine alongside server.js.
 *
 * Standalone CLI:
 *   node tunnel/client.js --port 3001 --server yourdomain.com --token SECRET   (TLS by default; --no-tls to disable)
 *
 * Programmatic (used by Site Manager):
 *   const { startTunnel } = require('./tunnel/client');
 *   const { publicUrl, stop } = await startTunnel({ localPort, serverHost, controlPort, token, tls, subdomain });
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const { TYPES, encode, FrameParser, stripHopByHop } = require('./protocol');

const RECONNECT_MIN = 3_000;   // first retry delay; doubles on each failure
const RECONNECT_MAX = 60_000;
const PING_INTERVAL = 25_000;

/**
 * Start a tunnel and return { publicUrl, stop }.
 * The returned promise resolves once the server confirms the tunnel is active (HELLO_ACK).
 * Auto-reconnects silently on disconnects until stop() is called.
 *
 * @param {object} options
 * @param {string}  options.serverHost   - Tunnel server hostname
 * @param {number}  [options.controlPort=7000]
 * @param {string}  options.token        - Shared secret
 * @param {number}  options.localPort    - Local port to expose
 * @param {boolean} [options.tls=true]   - Use TLS for the control connection
 * @param {boolean} [options.insecure=false] - Skip TLS certificate verification (self-signed dev certs only)
 * @param {string}  [options.subdomain]  - Preferred subdomain (server may override)
 * @returns {Promise<{ publicUrl: string, stop: () => void }>}
 */
function startTunnel(options) {
  const {
    serverHost,
    controlPort = 7000,
    token,
    localPort,
    tls:   useTls   = true,
    insecure        = false,
    subdomain: preferredSubdomain = null,
  } = options;

  if (!useTls) {
    console.warn('[Tunnel] WARNING: TLS is off — the token, visitors\' logins and page content cross the internet unencrypted.');
  } else if (insecure) {
    console.warn('[Tunnel] WARNING: TLS certificate verification is disabled (insecure mode).');
  }

  return new Promise((resolve, reject) => {
    let stopped   = false;
    let resolved  = false;
    let activeSocket = null;
    let pingTimer    = null;
    let retryDelay   = RECONNECT_MIN;

    function scheduleReconnect(reason) {
      if (stopped) return;
      console.error(`[Tunnel] ${reason}. Reconnecting in ${retryDelay / 1000}s...`);
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX);
    }

    function connect() {
      if (stopped) return;

      const reqModule = useTls ? https : http;
      const req = reqModule.request({
        host:               serverHost,
        port:               controlPort,
        path:               '/tunnel',
        rejectUnauthorized: !insecure,
        headers: {
          'Connection': 'Upgrade',
          'Upgrade':    'roweb-tunnel',
          'X-Token':    token,
        },
      });

      req.setTimeout(10_000, () => {
        req.destroy(new Error('Connection timeout'));
      });

      req.on('upgrade', (res, sock, head) => {
        activeSocket = sock;
        sock.setKeepAlive(true, 10_000);
        sock.on('error', () => sock.destroy());

        const parser = new FrameParser();
        if (head.length > 0) parser.push(head);
        sock.on('data', chunk => parser.push(chunk));

        parser.on('frame', ({ type, requestId, payload }) => {
          switch (type) {

            case TYPES.HELLO_ACK:
              retryDelay = RECONNECT_MIN;
              clearInterval(pingTimer);
              pingTimer = setInterval(() => {
                if (activeSocket && !activeSocket.destroyed) {
                  activeSocket.write(encode(TYPES.PING, 0, {}));
                }
              }, PING_INTERVAL);
              pingTimer.unref();

              if (!resolved) {
                resolved = true;
                resolve({ publicUrl: payload.publicUrl, stop });
              }
              console.log(`[Tunnel] Active → ${payload.publicUrl}`);
              break;

            case TYPES.HTTP_REQ:
              forwardRequest(requestId, payload, sock);
              break;

            case TYPES.PING:
              sock.write(encode(TYPES.PONG, 0, {}));
              break;

            case TYPES.PONG:
              break;

            case TYPES.ERROR:
              if (!resolved) reject(new Error(payload.message));
              else console.error(`[Tunnel] Server error: ${payload.message}`);
              break;
          }
        });

        parser.on('error', err => {
          console.error(`[Tunnel] Frame error: ${err.message}`);
          sock.destroy();
        });

        sock.on('close', () => {
          clearInterval(pingTimer);
          scheduleReconnect('Disconnected');
        });

        // Send HELLO
        sock.write(encode(TYPES.HELLO, 0, {
          token,
          localPort,
          subdomain: preferredSubdomain,
        }));
      });

      req.on('response', (res) => {
        // Server sent a normal HTTP response (not 101) — auth failure or misconfiguration
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          const err = new Error(`Server rejected upgrade with HTTP ${res.statusCode}${body ? ': ' + body.trim() : ''}`);
          if (!resolved) reject(err);
          else console.error(`[Tunnel] ${err.message}`);
        });
      });

      req.on('error', err => {
        if (!resolved) {
          reject(new Error(`Cannot connect to tunnel server: ${err.message}`));
        } else {
          scheduleReconnect(err.message);
        }
      });

      req.end();
    }

    function forwardRequest(requestId, { method, path: reqPath, headers, body: bodyB64 }, sock) {
      const bodyBuf = bodyB64 ? Buffer.from(bodyB64, 'base64') : null;

      if (typeof reqPath !== 'string' || !reqPath.startsWith('/')) {
        return sock.write(encode(TYPES.HTTP_RES, requestId, {
          statusCode: 400,
          headers:    { 'content-type': 'text/plain' },
          body:       Buffer.from('400 Bad Request').toString('base64'),
        }));
      }

      // The body arrives fully buffered, so the original framing headers no longer apply
      const fwdHeaders = stripHopByHop(headers, ['host', 'content-length']);
      fwdHeaders['host'] = `localhost:${localPort}`;
      if (bodyBuf && bodyBuf.length > 0) fwdHeaders['content-length'] = String(bodyBuf.length);

      const localReq = http.request({
        hostname: '127.0.0.1',
        port:     localPort,
        method,
        path:     reqPath,
        headers:  fwdHeaders,
      }, (localRes) => {
        const chunks = [];
        localRes.on('data', chunk => chunks.push(chunk));
        localRes.on('end', () => {
          sock.write(encode(TYPES.HTTP_RES, requestId, {
            statusCode: localRes.statusCode,
            headers:    localRes.headers,
            body:       Buffer.concat(chunks).toString('base64'),
          }));
        });
      });

      localReq.on('error', err => {
        sock.write(encode(TYPES.HTTP_RES, requestId, {
          statusCode: 502,
          headers:    { 'content-type': 'text/plain' },
          body:       Buffer.from(`502 Bad Gateway: ${err.message}`).toString('base64'),
        }));
      });

      if (bodyBuf && bodyBuf.length > 0) localReq.write(bodyBuf);
      localReq.end();
    }

    function stop() {
      stopped = true;
      clearInterval(pingTimer);
      if (activeSocket) activeSocket.destroy();
    }

    connect();
  });
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
  const has  = (name) => args.includes(name);

  const cfgPath = path.join(__dirname, 'tunnel-config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  const c = cfg.client || {};

  const options = {
    serverHost:  flag('--server')       || c.serverHost  || '',
    controlPort: parseInt(flag('--control-port') || c.controlPort || '7000', 10),
    token:       flag('--token')        || c.token        || '',
    localPort:   parseInt(flag('--port') || c.localPort  || '3000', 10),
    subdomain:   flag('--subdomain')    || c.subdomain   || null,
    tls:         !has('--no-tls')       && c.tls !== false,
    insecure:    has('--insecure')      || !!c.insecure,
  };

  if (!options.serverHost) {
    console.error('Error: --server <host> is required (or set client.serverHost in tunnel-config.json)');
    process.exit(1);
  }
  if (!options.token) {
    console.error('Error: --token <secret> is required (or set client.token in tunnel-config.json)');
    process.exit(1);
  }

  console.log(`[Tunnel] Connecting to ${options.serverHost}:${options.controlPort} for localhost:${options.localPort}...`);

  startTunnel(options)
    .then(({ publicUrl, stop }) => {
      console.log(`[Tunnel] Public URL: ${publicUrl}`);
      process.on('SIGINT', () => {
        console.log('\n[Tunnel] Stopping...');
        stop();
        process.exit(0);
      });
    })
    .catch(err => {
      console.error(`[Tunnel] Failed to start: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { startTunnel };

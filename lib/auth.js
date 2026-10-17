'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const net    = require('net');
const path   = require('path');
const { verifyPassword } = require('./passwords');

const MAX_ATTEMPTS   = 5;                // per client (IP or IPv6 /64) per port
const BLOCK_MS       = 10 * 60 * 1000;   // 10 minutes
const GLOBAL_MAX     = 100;              // failures per port per window, across all clients
const MAX_RECORDS    = 10_000;           // cap on tracked clients
const SESSION_MS     = 12 * 60 * 60 * 1000;
const MAX_SESSIONS   = 1_000;
const STORE_PATH     = path.join(__dirname, '..', 'data', 'login-attempts.json');

// key: "client:localPort" → { count, blockedUntil, lastSeen }
const loginAttempts = loadAttempts();
// localPort → { count, windowStart, blockedUntil }
const portFailures = new Map();
// Proof of a previous successful login: sha256(header|user|stored secret) → expiry.
// Avoids re-running scrypt on every asset request, and keeps logged-in users working during a port-wide lockout.
const verified = new Map();

function loadAttempts() {
  try {
    const now = Date.now();
    const saved = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return new Map(Object.entries(saved).filter(([, r]) => r.blockedUntil > now || r.lastSeen > now - BLOCK_MS));
  } catch {
    return new Map();
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveAttempts, 1000);
  saveTimer.unref();
}
function saveAttempts() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(Object.fromEntries(loginAttempts)), 'utf8');
  } catch (err) {
    console.error(`Could not persist login attempts: ${err.message}`);
  }
}
process.on('exit', () => { if (saveTimer) saveAttempts(); });

setInterval(() => {
  const now = Date.now();
  const cutoff = now - BLOCK_MS;
  let changed = false;
  for (const [key, rec] of loginAttempts) {
    if (rec.blockedUntil < cutoff && rec.lastSeen < cutoff) { loginAttempts.delete(key); changed = true; }
  }
  for (const [key, exp] of verified) if (exp < now) verified.delete(key);
  if (changed) scheduleSave();
}, 15 * 60 * 1000).unref();

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// IPv6 users typically control a whole /64, so treat it as one client
function clientKey(ip) {
  ip = String(ip).split('%')[0];
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) return ip.slice(7);
  if (!net.isIPv6(ip)) return ip;
  let groups;
  if (ip.includes('::')) {
    const [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  } else {
    groups = ip.split(':');
  }
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

// Tunnelled requests arrive from the local tunnel client on loopback. Use the LAST
// X-Forwarded-For entry: it's the one added by the nearest proxy (the tunnel server
// overwrites it; nginx/Caddy append), so earlier client-supplied values are ignored.
function clientIp(req) {
  const ip  = req.socket.remoteAddress || 'unknown';
  const fwd = req.headers['x-forwarded-for'];
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (loopback && typeof fwd === 'string' && fwd.trim()) return fwd.split(',').pop().trim();
  return ip;
}

function quoteRealm(realm) {
  return String(realm).replace(/[\r\n]/g, ' ').replace(/["\\]/g, '\\$&');
}

function normalizeRulePath(p) {
  const s = '/' + String(p || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  return (s.replace(/\/+$/, '') || '/').toLowerCase();
}

// Returns the most specific protected-URL rule matching relPath, else the site-wide auth (or null).
// Matching is case-insensitive so it can't be bypassed on case-insensitive filesystems.
function pickAuth(site, relPath) {
  const target = relPath.toLowerCase();
  let best = null;
  for (const rule of site.protectedPaths || []) {
    const p = normalizeRulePath(rule.path);
    const hit = p === '/' || target === p || target.startsWith(p + '/');
    if (hit && (!best || p.length > best.len)) best = { len: p.length, rule };
  }
  if (best) return { realm: best.rule.path, ...best.rule };
  return site.auth || null;
}

function tooMany(res, secsLeft, msg) {
  res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(secsLeft) });
  res.end(`429 Too Many Requests — ${msg} Try again in ${Math.ceil(secsLeft / 60)} minute(s).`);
}

function rememberVerified(key) {
  verified.delete(key);
  verified.set(key, Date.now() + SESSION_MS);
  if (verified.size > MAX_SESSIONS) verified.delete(verified.keys().next().value);
}

async function checkPassword(pass, authConfig) {
  if (authConfig.passHash) return verifyPassword(pass, authConfig.passHash);
  return authConfig.pass !== undefined && safeEqual(pass, authConfig.pass);
}

// Resolves true if the request may proceed; otherwise sends 401/429 and resolves false.
async function checkAuth(req, res, authConfig) {
  if (!authConfig) return true;

  const realm  = quoteRealm(authConfig.realm || 'Restricted');
  const port   = req.socket.localPort;
  const key    = `${clientKey(clientIp(req))}:${port}`;
  const now    = Date.now();
  const header = req.headers['authorization'];
  const hasCreds = typeof header === 'string' && header.startsWith('Basic ');

  const sessionKey = hasCreds && crypto.createHash('sha256')
    .update(`${header}|${authConfig.user}|${authConfig.passHash || authConfig.pass}`).digest('hex');
  if (sessionKey && (verified.get(sessionKey) || 0) > now) return true;

  let rec = loginAttempts.get(key);
  if (rec && rec.blockedUntil > now) {
    tooMany(res, Math.ceil((rec.blockedUntil - now) / 1000), 'Too many failed login attempts.');
    return false;
  }
  if (rec && rec.blockedUntil > 0) {
    loginAttempts.delete(key);
    rec = undefined;
    scheduleSave();
  }

  const global = portFailures.get(port);
  if (global && global.blockedUntil > now) {
    tooMany(res, Math.ceil((global.blockedUntil - now) / 1000), 'Logins for this site are temporarily disabled after many failed attempts.');
    return false;
  }

  // No credentials yet — browser hasn't shown the dialog; don't count this
  if (!hasCreds) {
    send401(res, realm, '401 Unauthorized');
    return false;
  }

  const decoded  = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  const user = colonIdx === -1 ? decoded : decoded.slice(0, colonIdx);
  const pass = colonIdx === -1 ? ''      : decoded.slice(colonIdx + 1);

  // Always run the password check so a wrong username takes the same time
  const passOk = await checkPassword(pass, authConfig);
  const userOk = safeEqual(user, authConfig.user);

  if (userOk && passOk) {
    rememberVerified(sessionKey);
    if (rec) { loginAttempts.delete(key); scheduleSave(); }
    return true;
  }

  recordGlobalFailure(port, now);

  const count        = (rec ? rec.count : 0) + 1;
  const blockedUntil = count >= MAX_ATTEMPTS ? now + BLOCK_MS : 0;
  loginAttempts.delete(key);
  loginAttempts.set(key, { count, blockedUntil, lastSeen: now });
  if (loginAttempts.size > MAX_RECORDS) loginAttempts.delete(loginAttempts.keys().next().value);
  scheduleSave();

  if (blockedUntil) {
    tooMany(res, BLOCK_MS / 1000, 'Too many failed login attempts.');
    return false;
  }
  send401(res, realm, `401 Unauthorized — ${MAX_ATTEMPTS - count} attempt(s) remaining before lockout.`);
  return false;
}

function recordGlobalFailure(port, now) {
  let g = portFailures.get(port);
  if (!g || now - g.windowStart > BLOCK_MS) g = { count: 0, windowStart: now, blockedUntil: 0 };
  g.count++;
  if (g.count >= GLOBAL_MAX && !g.blockedUntil) {
    g.blockedUntil = now + BLOCK_MS;
    console.warn(`[auth] ${GLOBAL_MAX} failed logins on port ${port} in 10 minutes — new logins paused for 10 minutes.`);
  }
  portFailures.set(port, g);
}

function send401(res, realm, body) {
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`,
    'Content-Type':     'text/plain; charset=utf-8',
  });
  res.end(body);
}

module.exports = { checkAuth, pickAuth, normalizeRulePath, safeEqual, clientKey };

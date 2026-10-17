'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const MAX_ATTEMPTS = 5;
const BLOCK_MS     = 10 * 60 * 1000; // 10 minutes
const STORE_PATH   = path.join(__dirname, '..', 'data', 'login-attempts.json');

// key: "clientIP:localPort" → { count, blockedUntil, lastSeen }
const loginAttempts = loadAttempts();

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
  const cutoff = Date.now() - BLOCK_MS;
  let changed = false;
  for (const [key, rec] of loginAttempts) {
    if (rec.blockedUntil < cutoff && rec.lastSeen < cutoff) { loginAttempts.delete(key); changed = true; }
  }
  if (changed) scheduleSave();
}, 15 * 60 * 1000).unref();

// Hashing first gives equal-length buffers, so neither content nor length leaks through timing.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Tunnelled requests arrive from the local tunnel client on loopback; the tunnel server
// overwrites X-Forwarded-For with the real public IP, so trust it only from loopback.
function clientIp(req) {
  const ip  = req.socket.remoteAddress || 'unknown';
  const fwd = req.headers['x-forwarded-for'];
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (loopback && typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
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

function checkAuth(req, res, authConfig) {
  if (!authConfig) return true;

  const realm = quoteRealm(authConfig.realm || 'Restricted');
  const key   = `${clientIp(req)}:${req.socket.localPort}`;
  const now   = Date.now();

  let rec = loginAttempts.get(key);

  if (rec && rec.blockedUntil > now) {
    const secsLeft = Math.ceil((rec.blockedUntil - now) / 1000);
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': String(secsLeft) });
    res.end(`429 Too Many Requests — Too many failed login attempts. Try again in ${Math.ceil(secsLeft / 60)} minute(s).`);
    return false;
  }

  if (rec && rec.blockedUntil > 0) {
    loginAttempts.delete(key);
    rec = undefined;
    scheduleSave();
  }

  const header = req.headers['authorization'];

  // No credentials yet — browser hasn't shown the dialog; don't count this
  if (!header || !header.startsWith('Basic ')) {
    send401(res, realm, '401 Unauthorized');
    return false;
  }

  const decoded  = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  const user = colonIdx === -1 ? decoded : decoded.slice(0, colonIdx);
  const pass = colonIdx === -1 ? ''      : decoded.slice(colonIdx + 1);

  // Bitwise & so both comparisons always run
  const ok = safeEqual(user, authConfig.user) & safeEqual(pass, authConfig.pass);

  if (!ok) {
    const count        = (rec ? rec.count : 0) + 1;
    const blockedUntil = count >= MAX_ATTEMPTS ? now + BLOCK_MS : 0;
    loginAttempts.set(key, { count, blockedUntil, lastSeen: now });
    scheduleSave();

    if (blockedUntil) {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': String(BLOCK_MS / 1000) });
      res.end('429 Too Many Requests — Too many failed login attempts. Try again in 10 minutes.');
      return false;
    }

    send401(res, realm, `401 Unauthorized — ${MAX_ATTEMPTS - count} attempt(s) remaining before lockout.`);
    return false;
  }

  if (rec) {
    loginAttempts.delete(key);
    scheduleSave();
  }
  return true;
}

function send401(res, realm, body) {
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`,
    'Content-Type':     'text/plain; charset=utf-8',
  });
  res.end(body);
}

module.exports = { checkAuth, pickAuth, normalizeRulePath, safeEqual };

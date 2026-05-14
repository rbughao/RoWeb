'use strict';

const crypto = require('crypto');

const MAX_ATTEMPTS = 5;
const BLOCK_MS     = 10 * 60 * 1000; // 10 minutes

// key: "remoteIP:localPort" → { count, blockedUntil, lastSeen }
const loginAttempts = new Map();

// Purge fully-expired records every 15 minutes so the map doesn't grow forever
setInterval(() => {
  const cutoff = Date.now() - BLOCK_MS;
  for (const [key, rec] of loginAttempts) {
    if (rec.blockedUntil < cutoff && rec.lastSeen < cutoff) loginAttempts.delete(key);
  }
}, 15 * 60 * 1000).unref();

function checkAuth(req, res, authConfig) {
  if (!authConfig) return true;

  const realm = authConfig.realm || 'Restricted';
  const ip    = req.socket.remoteAddress || 'unknown';
  const port  = req.socket.localPort;
  const key   = `${ip}:${port}`;
  const now   = Date.now();

  let rec = loginAttempts.get(key);

  // Active block
  if (rec && rec.blockedUntil > now) {
    const secsLeft = Math.ceil((rec.blockedUntil - now) / 1000);
    const minsLeft = Math.ceil(secsLeft / 60);
    res.writeHead(429, {
      'Content-Type': 'text/plain',
      'Retry-After':  String(secsLeft),
    });
    res.end(`429 Too Many Requests — Too many failed login attempts. Try again in ${minsLeft} minute(s).`);
    return false;
  }

  // Block has expired — reset
  if (rec && rec.blockedUntil > 0 && rec.blockedUntil <= now) {
    loginAttempts.delete(key);
    rec = undefined;
  }

  const header = req.headers['authorization'];

  // No credentials yet — browser hasn't shown the dialog; don't count this
  if (!header || !header.startsWith('Basic ')) {
    send401(res, realm);
    return false;
  }

  const encoded  = header.slice(6);
  const decoded  = Buffer.from(encoded, 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) {
    send401(res, realm);
    return false;
  }

  const user = decoded.slice(0, colonIdx);
  const pass = decoded.slice(colonIdx + 1);

  const expectedUser = Buffer.from(authConfig.user);
  const expectedPass = Buffer.from(authConfig.pass);
  const actualUser   = Buffer.from(user);
  const actualPass   = Buffer.from(pass);

  const userMatch =
    actualUser.length === expectedUser.length &&
    crypto.timingSafeEqual(actualUser, expectedUser);
  const passMatch =
    actualPass.length === expectedPass.length &&
    crypto.timingSafeEqual(actualPass, expectedPass);

  if (!userMatch || !passMatch) {
    const count       = (rec ? rec.count : 0) + 1;
    const blockedUntil = count >= MAX_ATTEMPTS ? now + BLOCK_MS : 0;
    loginAttempts.set(key, { count, blockedUntil, lastSeen: now });

    if (blockedUntil) {
      res.writeHead(429, {
        'Content-Type': 'text/plain',
        'Retry-After':  String(BLOCK_MS / 1000),
      });
      res.end('429 Too Many Requests — Too many failed login attempts. Try again in 10 minutes.');
      return false;
    }

    const attemptsLeft = MAX_ATTEMPTS - count;
    res.writeHead(401, {
      'WWW-Authenticate': `Basic realm="${realm}"`,
      'Content-Type':     'text/plain',
    });
    res.end(`401 Unauthorized — ${attemptsLeft} attempt(s) remaining before lockout.`);
    return false;
  }

  // Success — clear failure record
  if (rec) loginAttempts.delete(key);
  return true;
}

function send401(res, realm) {
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${realm}"`,
    'Content-Type':     'text/plain',
  });
  res.end('401 Unauthorized');
}

module.exports = { checkAuth };

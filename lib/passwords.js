'use strict';

const crypto = require('crypto');

const N = 16384, R = 8, P = 1, KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

// Passwords shipped in earlier versions / docs — anyone could know them
const KNOWN_DEFAULTS = ['manager123', 'secret123', 'wiki2024', 'home123', 'admin', 'password'];

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function parse(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isInteger) || n < 2 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || hash.length === 0) return null;
  return { params: { N: n, r, p, maxmem: MAXMEM }, salt, hash };
}

function verifyPassword(pw, stored) {
  const parsed = parse(stored);
  if (!parsed) return Promise.resolve(false);
  return new Promise(resolve => {
    crypto.scrypt(String(pw), parsed.salt, parsed.hash.length, parsed.params, (err, key) => {
      resolve(!err && crypto.timingSafeEqual(key, parsed.hash));
    });
  });
}

function verifyPasswordSync(pw, stored) {
  const parsed = parse(stored);
  if (!parsed) return false;
  try {
    return crypto.timingSafeEqual(crypto.scryptSync(String(pw), parsed.salt, parsed.hash.length, parsed.params), parsed.hash);
  } catch {
    return false;
  }
}

function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

function isKnownDefault(entry) {
  if (entry.pass !== undefined) return KNOWN_DEFAULTS.includes(String(entry.pass));
  return KNOWN_DEFAULTS.some(d => verifyPasswordSync(d, entry.passHash));
}

// Replaces a plaintext `pass` with `passHash` in place
function hashEntry(entry) {
  if (entry && entry.pass !== undefined && entry.pass !== '') {
    entry.passHash = hashPassword(entry.pass);
  }
  if (entry) delete entry.pass;
}

// Every credential object in a site: [label, entry]
function siteCredentials(site) {
  const list = [];
  if (site.auth) list.push([`${site.name}`, site.auth]);
  for (const rule of site.protectedPaths || []) list.push([`${site.name} ${rule.path}`, rule]);
  return list;
}

function hashSiteSecrets(site) {
  for (const [, entry] of siteCredentials(site)) hashEntry(entry);
}

module.exports = {
  KNOWN_DEFAULTS,
  hashPassword, verifyPassword, verifyPasswordSync, generatePassword,
  isKnownDefault, hashEntry, siteCredentials, hashSiteSecrets,
};

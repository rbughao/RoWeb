'use strict';

const SITE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options':        'SAMEORIGIN',
  'Referrer-Policy':        'strict-origin-when-cross-origin',
};

// The manager UI uses inline scripts/handlers, so 'unsafe-inline' is required; everything else is locked to self.
const MANAGER_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options':        'DENY',
  'Referrer-Policy':        'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function apply(res, headers) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

module.exports = {
  setSiteHeaders:    res => apply(res, SITE_HEADERS),
  setManagerHeaders: res => apply(res, MANAGER_HEADERS),
};

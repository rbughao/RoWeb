'use strict';

const SITE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy':        'strict-origin-when-cross-origin',
};

const MANAGER_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options':        'DENY',
  'Referrer-Policy':        'no-referrer',
};

function apply(res, headers) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

// Sites may be framed only by themselves and by the Site Manager's preview pane
// (replaces X-Frame-Options, which can't name another origin).
function setSiteHeaders(res, managerOrigins = '') {
  apply(res, SITE_HEADERS);
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${managerOrigins}`.trim());
}

// frameHost: the validated hostname the manager is being viewed on; the preview pane
// embeds sites on that same host. The UI uses inline scripts/handlers, hence 'unsafe-inline'.
function setManagerHeaders(res, frameHost) {
  apply(res, MANAGER_HEADERS);
  // CSP can't express IPv6 literals; previews then aren't supported (use 127.0.0.1 or localhost)
  const host = frameHost && !frameHost.includes(':') ? frameHost : null;
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    host ? `frame-src http://${host}:*` : "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
}

module.exports = { setSiteHeaders, setManagerHeaders };

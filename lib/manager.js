'use strict';

const http = require('http');
const net  = require('net');
const fs   = require('fs');
const path = require('path');
const { getMime }           = require('./mimeTypes');
const { checkAuth, normalizeRulePath } = require('./auth');
const { setManagerHeaders } = require('./securityHeaders');
const { startTunnel }       = require('../tunnel/client');

const UI_ROOT          = path.join(__dirname, '..', 'sites', 'manager');
const TUNNEL_CFG_PATH  = path.join(__dirname, '..', 'tunnel', 'tunnel-config.json');

function createManagerServer(port, siteManager) {
  const managerCfg   = siteManager.config.manager || {};
  const authConfig   = managerCfg.auth || null;
  const allowedHosts = (managerCfg.allowedHosts || []).map(h => String(h).toLowerCase());

  const server = http.createServer((req, res) => {
    setManagerHeaders(res);

    // Blocks DNS-rebinding: a malicious hostname resolving to 127.0.0.1 won't match
    if (!isAllowedHost(req.headers.host, allowedHosts)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('403 Forbidden — host not allowed. Add it to manager.allowedHosts in config.json.');
    }

    if (!checkAuth(req, res, authConfig)) return;

    const urlPath = (req.url || '/').split('?')[0];

    if (urlPath.startsWith('/api/')) {
      // Cross-site pages can't set a custom header without a CORS preflight, which we never grant
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (req.headers['x-requested-with'] !== 'RoWeb' || (origin && !sameOrigin(origin, req.headers.host))) {
          return jsonResponse(res, 403, { ok: false, error: 'Cross-site request blocked.' });
        }
      }
      return handleAPI(req, res, urlPath, siteManager, port);
    }

    serveStatic(res, urlPath);
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(port);
  return server;
}

function isAllowedHost(hostHeader, allowedHosts) {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || net.isIP(host) !== 0 || allowedHosts.includes(host);
}

function sameOrigin(origin, host) {
  try { return new URL(origin).host === String(host || '').toLowerCase(); } catch { return false; }
}

// ── API ──────────────────────────────────────────────────────────────────────

function handleAPI(req, res, pathname, siteManager, managerPort) {
  const parts = pathname.split('/').filter(Boolean); // e.g. ['api', 'sites', '3001']

  // ── Tunnel routes ─────────────────────────────────────────────────────────

  if (req.method === 'GET' && parts[1] === 'tunnel' && parts[2] === 'config') {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(TUNNEL_CFG_PATH, 'utf8')); } catch {}
    return jsonResponse(res, 200, { ok: true, config: cfg });
  }

  if (req.method === 'PUT' && parts[1] === 'tunnel' && parts[2] === 'config') {
    readJson(req, res, (cfg) => {
      const s = cfg.server || {};
      const c = cfg.client || {};
      if (!isNonEmpty(s.domain))   return jsonResponse(res, 400, { ok: false, error: 'Domain is required.' });
      if (!isNonEmpty(s.certFile)) return jsonResponse(res, 400, { ok: false, error: 'TLS certificate file path is required.' });
      if (!isNonEmpty(s.keyFile))  return jsonResponse(res, 400, { ok: false, error: 'TLS key file path is required.' });
      if (typeof s.token !== 'string' || s.token.length < 16) return jsonResponse(res, 400, { ok: false, error: 'Token must be at least 16 characters.' });
      if (s.token !== c.token)     return jsonResponse(res, 400, { ok: false, error: 'Server and client tokens must match.' });

      cfg.server = { ...s, controlPort: parseInt(s.controlPort || 7000, 10) };
      cfg.client = { ...c, controlPort: parseInt(c.controlPort || s.controlPort || 7000, 10), tls: !!c.tls, insecure: !!c.insecure };

      try {
        fs.writeFileSync(TUNNEL_CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
        jsonResponse(res, 200, { ok: true });
      } catch (e) {
        jsonResponse(res, 500, { ok: false, error: `Could not write config: ${e.message}` });
      }
    });
    return;
  }

  if (req.method === 'POST' && parts[1] === 'tunnel' && parts.length === 3) {
    const port = parseInt(parts[2], 10);
    if (siteManager.activeTunnels.has(port)) {
      return jsonResponse(res, 400, { ok: false, error: `A tunnel for port ${port} is already active.` });
    }

    let tunnelCfg;
    try {
      tunnelCfg = JSON.parse(fs.readFileSync(TUNNEL_CFG_PATH, 'utf8'));
    } catch {
      return jsonResponse(res, 500, { ok: false, error: 'tunnel/tunnel-config.json not found. Fill it in before creating tunnels.' });
    }

    const c = tunnelCfg.client || {};
    if (!c.serverHost || !c.token) {
      return jsonResponse(res, 500, { ok: false, error: 'tunnel-config.json: client.serverHost and client.token are required.' });
    }

    const site = siteManager.config.sites.find(s => s.port === port);
    const preferredSubdomain = site && site.tunnel ? site.tunnel.subdomain : null;

    startTunnel({
      serverHost:  c.serverHost,
      controlPort: c.controlPort || 7000,
      token:       c.token,
      localPort:   port,
      tls:         !!c.tls,
      insecure:    !!c.insecure,
      subdomain:   preferredSubdomain,
    }).then(({ publicUrl, stop }) => {
      siteManager.activeTunnels.set(port, { publicUrl, stop });
      jsonResponse(res, 200, { ok: true, publicUrl, sites: siteManager.getSites() });
    }).catch(err => {
      jsonResponse(res, 500, { ok: false, error: err.message });
    });
    return;
  }

  if (req.method === 'DELETE' && parts[1] === 'tunnel' && parts.length === 3) {
    const port = parseInt(parts[2], 10);
    const tunnel = siteManager.activeTunnels.get(port);
    if (!tunnel) {
      return jsonResponse(res, 404, { ok: false, error: `No active tunnel for port ${port}.` });
    }
    tunnel.stop();
    siteManager.activeTunnels.delete(port);
    return jsonResponse(res, 200, { ok: true, sites: siteManager.getSites() });
  }

  // ── Site routes ───────────────────────────────────────────────────────────

  if (parts[1] !== 'sites') {
    return jsonResponse(res, 404, { ok: false, error: 'Not found' });
  }

  if (req.method === 'GET' && parts.length === 2) {
    return jsonResponse(res, 200, { ok: true, sites: siteManager.getSites(), managerPort });
  }

  if (req.method === 'POST' && parts.length === 2) {
    readJson(req, res, async (site) => {
      const validErr = validateSite(site, siteManager, null, managerPort);
      if (validErr) return jsonResponse(res, 400, { ok: false, error: validErr });

      try {
        await siteManager.addSite(site);
        jsonResponse(res, 200, { ok: true, sites: siteManager.getSites() });
      } catch (e) {
        jsonResponse(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }

  if (req.method === 'PUT' && parts.length === 3) {
    const oldPort = parseInt(parts[2], 10);
    readJson(req, res, async (site) => {
      const existing = siteManager.config.sites.find(s => s.port === oldPort);
      keepExistingSecrets(site, existing);

      const validErr = validateSite(site, siteManager, oldPort, managerPort);
      if (validErr) return jsonResponse(res, 400, { ok: false, error: validErr });

      try {
        await siteManager.updateSite(oldPort, site);
        jsonResponse(res, 200, { ok: true, sites: siteManager.getSites() });
      } catch (e) {
        jsonResponse(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }

  if (req.method === 'DELETE' && parts.length === 3) {
    const port = parseInt(parts[2], 10);
    if (port === managerPort) {
      return jsonResponse(res, 400, { ok: false, error: 'Cannot delete the manager port.' });
    }
    siteManager.removeSite(port)
      .then(() => jsonResponse(res, 200, { ok: true, sites: siteManager.getSites() }))
      .catch(e => jsonResponse(res, 400, { ok: false, error: e.message }));
    return;
  }

  jsonResponse(res, 404, { ok: false, error: 'Not found' });
}

// The UI never receives passwords, so a blank password on edit means "keep the current one".
function keepExistingSecrets(site, existing) {
  if (!existing || !site || typeof site !== 'object') return;
  if (site.auth && typeof site.auth === 'object' && !site.auth.pass && existing.auth) {
    site.auth.pass = existing.auth.pass;
  }
  if (Array.isArray(site.protectedPaths)) {
    for (const rule of site.protectedPaths) {
      if (!rule || typeof rule !== 'object' || rule.pass) continue;
      const prev = (existing.protectedPaths || []).find(r => normalizeRulePath(r.path) === normalizeRulePath(rule.path));
      if (prev) rule.pass = prev.pass;
    }
  }
}

function isNonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function validateSite(site, siteManager, editingPort, managerPort) {
  if (!site || typeof site !== 'object' || Array.isArray(site)) return 'Invalid site data.';
  if (!isNonEmpty(site.name)) return 'Site name is required.';
  const port = typeof site.port === 'string' ? parseInt(site.port, 10) : site.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'A valid port (1–65535) is required.';
  site.port = port;
  if (!isNonEmpty(site.root)) return 'Root directory is required.';
  if (site.index !== undefined && !isNonEmpty(site.index)) return 'Index file must be a file name.';

  if (site.auth !== undefined) {
    if (!site.auth || typeof site.auth !== 'object') return 'Invalid auth settings.';
    if (!isNonEmpty(site.auth.user)) return 'Auth username is required.';
    if (!isNonEmpty(site.auth.pass)) return 'Auth password is required.';
  }

  if (site.protectedPaths !== undefined) {
    if (!Array.isArray(site.protectedPaths)) return 'Protected URLs must be a list.';
    const seen = new Set();
    for (const rule of site.protectedPaths) {
      if (!rule || typeof rule !== 'object') return 'Invalid protected URL entry.';
      if (!isNonEmpty(rule.path) || !rule.path.trim().startsWith('/')) return 'Each protected URL must start with "/" (e.g. /reports).';
      if (rule.path.includes('..')) return `Protected URL ${rule.path} must not contain "..".`;
      if (!isNonEmpty(rule.user)) return `Protected URL ${rule.path} needs a username.`;
      if (!isNonEmpty(rule.pass)) return `Protected URL ${rule.path} needs a password.`;
      rule.path = rule.path.trim();
      const key = normalizeRulePath(rule.path);
      if (seen.has(key)) return `Protected URL ${rule.path} is listed twice.`;
      seen.add(key);
    }
    if (site.protectedPaths.length === 0) delete site.protectedPaths;
  }

  if (port === managerPort) return `Port ${port} is used by the Site Manager itself.`;
  const conflict = siteManager.config.sites.find(s => s.port === port && s.port !== editingPort);
  if (conflict) return `Port ${port} is already in use by "${conflict.name}".`;
  return null;
}

// ── Static file serving ───────────────────────────────────────────────────────

function serveStatic(res, urlPath) {
  if (urlPath.includes('..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }
  const filePath = urlPath === '/'
    ? path.join(UI_ROOT, 'index.html')
    : path.join(UI_ROOT, urlPath.replace(/^\//, ''));

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': getMime(path.extname(filePath)), 'Content-Length': data.length });
    res.end(data);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson(req, res, cb) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
  req.on('error', () => jsonResponse(res, 400, { ok: false, error: 'Could not read request body' }));
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch { return jsonResponse(res, 400, { ok: false, error: 'Invalid JSON' }); }
    Promise.resolve(cb(data)).catch(err => {
      if (!res.headersSent) jsonResponse(res, 500, { ok: false, error: err.message });
    });
  });
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control':  'no-store',
  });
  res.end(body);
}

module.exports = { createManagerServer };

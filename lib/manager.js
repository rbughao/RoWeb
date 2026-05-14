'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { getMime }      = require('./mimeTypes');
const { checkAuth }    = require('./auth');
const { startTunnel }  = require('../tunnel/client');

const UI_ROOT          = path.join(__dirname, '..', 'sites', 'manager');
const TUNNEL_CFG_PATH  = path.join(__dirname, '..', 'tunnel', 'tunnel-config.json');

function createManagerServer(port, siteManager) {
  const authConfig = siteManager.config.manager && siteManager.config.manager.auth
    ? siteManager.config.manager.auth
    : null;

  const server = http.createServer((req, res) => {
    // CORS for same-origin fetch (no external access expected)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!checkAuth(req, res, authConfig)) return;

    const urlPath = (req.url || '/').split('?')[0];

    if (urlPath.startsWith('/api/')) {
      return handleAPI(req, res, urlPath, siteManager, port);
    }

    serveStatic(res, urlPath);
  });

  server.listen(port);
  return server;
}

// ── API ──────────────────────────────────────────────────────────────────────

function handleAPI(req, res, pathname, siteManager, managerPort) {
  const parts = pathname.split('/').filter(Boolean); // e.g. ['api', 'sites', '3001']

  // ── Tunnel routes ─────────────────────────────────────────────────────────

  // GET /api/tunnel/config → read tunnel-config.json
  if (req.method === 'GET' && parts[1] === 'tunnel' && parts[2] === 'config') {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(TUNNEL_CFG_PATH, 'utf8')); } catch {}
    return jsonResponse(res, 200, { ok: true, config: cfg });
  }

  // PUT /api/tunnel/config → write tunnel-config.json
  if (req.method === 'PUT' && parts[1] === 'tunnel' && parts[2] === 'config') {
    readBody(req, (err, body) => {
      if (err) return jsonResponse(res, 400, { ok: false, error: 'Could not read request body' });
      let cfg;
      try { cfg = JSON.parse(body); } catch { return jsonResponse(res, 400, { ok: false, error: 'Invalid JSON' }); }

      const s = cfg.server || {};
      const c = cfg.client || {};
      if (!s.domain  || !s.domain.trim())   return jsonResponse(res, 400, { ok: false, error: 'Domain is required.' });
      if (!s.certFile|| !s.certFile.trim())  return jsonResponse(res, 400, { ok: false, error: 'TLS certificate file path is required.' });
      if (!s.keyFile || !s.keyFile.trim())   return jsonResponse(res, 400, { ok: false, error: 'TLS key file path is required.' });
      if (!s.token   || s.token.length < 16) return jsonResponse(res, 400, { ok: false, error: 'Token must be at least 16 characters.' });
      if (s.token !== c.token)               return jsonResponse(res, 400, { ok: false, error: 'Server and client tokens must match.' });

      cfg.server.controlPort = parseInt(s.controlPort || 7000, 10);
      cfg.client.controlPort = parseInt(c.controlPort || s.controlPort || 7000, 10);

      try {
        fs.writeFileSync(TUNNEL_CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
        jsonResponse(res, 200, { ok: true });
      } catch (e) {
        jsonResponse(res, 500, { ok: false, error: `Could not write config: ${e.message}` });
      }
    });
    return;
  }

  // POST /api/tunnel/:port → start tunnel for a site
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
      subdomain:   preferredSubdomain,
    }).then(({ publicUrl, stop }) => {
      siteManager.activeTunnels.set(port, { publicUrl, stop });
      jsonResponse(res, 200, { ok: true, publicUrl, sites: siteManager.getSites() });
    }).catch(err => {
      jsonResponse(res, 500, { ok: false, error: err.message });
    });
    return;
  }

  // DELETE /api/tunnel/:port → stop tunnel
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

  // GET /api/sites
  if (req.method === 'GET' && parts.length === 2) {
    return jsonResponse(res, 200, { ok: true, sites: siteManager.getSites(), managerPort });
  }

  // POST /api/sites → add
  if (req.method === 'POST' && parts.length === 2) {
    readBody(req, async (err, body) => {
      if (err) return jsonResponse(res, 400, { ok: false, error: 'Could not read request body' });
      let site;
      try { site = JSON.parse(body); } catch { return jsonResponse(res, 400, { ok: false, error: 'Invalid JSON' }); }

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

  // PUT /api/sites/:port → update
  if (req.method === 'PUT' && parts.length === 3) {
    const oldPort = parseInt(parts[2], 10);
    readBody(req, async (err, body) => {
      if (err) return jsonResponse(res, 400, { ok: false, error: 'Could not read request body' });
      let site;
      try { site = JSON.parse(body); } catch { return jsonResponse(res, 400, { ok: false, error: 'Invalid JSON' }); }

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

  // DELETE /api/sites/:port
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

function validateSite(site, siteManager, editingPort, managerPort) {
  if (!site.name || typeof site.name !== 'string' || !site.name.trim()) return 'Site name is required.';
  const port = typeof site.port === 'string' ? parseInt(site.port, 10) : site.port;
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535) return 'A valid port (1–65535) is required.';
  site.port = port;
  if (!site.root || typeof site.root !== 'string' || !site.root.trim()) return 'Root directory is required.';
  if (site.auth) {
    if (!site.auth.user || !site.auth.user.trim()) return 'Auth username is required.';
    if (!site.auth.pass || !site.auth.pass.trim()) return 'Auth password is required.';
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
    res.writeHead(200, { 'Content-Type': getMime(path.extname(filePath)) });
    res.end(data);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => cb(null, body));
  req.on('error', err => cb(err));
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

module.exports = { createManagerServer };

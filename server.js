'use strict';

const http = require('http');
const net  = require('net');
const fs   = require('fs');
const path = require('path');

const { checkAuth, pickAuth }           = require('./lib/auth');
const { resolveFilePath, canonicalize, rootProblem, serveFile, sendStatus } = require('./lib/fileServer');
const { printStartupTable, logRequest } = require('./lib/logger');
const { createManagerServer, SUBDOMAIN_RE } = require('./lib/manager');
const { setSiteHeaders }                = require('./lib/securityHeaders');
const passwords                         = require('./lib/passwords');

const configPath  = path.join(__dirname, 'config.json');
const examplePath = path.join(__dirname, 'config.example.json');

if (!fs.existsSync(configPath)) {
  fs.copyFileSync(examplePath, configPath);
  console.log('Created config.json from config.example.json.');
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`Failed to read config.json: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(config.sites) || config.sites.length === 0) {
  console.error('config.json must have a non-empty "sites" array.');
  process.exit(1);
}

const sitesDir = config.sitesDir || './sites';
const tunnelAddresses = new Map(); // subdomain → site name

for (const site of config.sites) {
  if (site.tunnel && site.tunnel.subdomain) {
    const sub = String(site.tunnel.subdomain).toLowerCase();
    if (!SUBDOMAIN_RE.test(sub)) {
      console.error(`Site "${site.name}": tunnel address "${site.tunnel.subdomain}" may use only letters, numbers and hyphens.`);
      process.exit(1);
    }
    // Two tunnels asking for one address would keep taking it from each other
    if (tunnelAddresses.has(sub)) {
      console.error(`Sites "${tunnelAddresses.get(sub)}" and "${site.name}" both use tunnel address "${sub}".`);
      process.exit(1);
    }
    tunnelAddresses.set(sub, site.name);
  }
  if (!site.name || !site.port || !site.root) {
    console.error(`Invalid site entry (missing name, port, or root): ${JSON.stringify(site)}`);
    process.exit(1);
  }
  const rootErr = rootProblem(site.root, {
    projectDir: __dirname,
    sitesDir,
    otherRoots: config.sites.filter(s => s !== site).map(s => s.root),
  });
  if (rootErr) {
    console.error(`Site "${site.name}": ${rootErr}`);
    process.exit(1);
  }
  if (site.host !== undefined && site.host !== 'localhost' && !net.isIP(site.host)) {
    console.error(`Site "${site.name}": "host" must be an IP address or "localhost".`);
    process.exit(1);
  }
  for (const [label, entry] of passwords.siteCredentials(site)) {
    if (!entry.user) {
      console.error(`"${label}" has a login with no username.`);
      process.exit(1);
    }
    if (entry !== site.auth && !entry.path) {
      console.error(`Site "${site.name}" has a protected URL with no path.`);
      process.exit(1);
    }
  }
}

secureCredentials();

// Replaces missing, default or publicly known passwords with random ones (printed once),
// then stores every password as an scrypt hash.
function secureCredentials() {
  const generated = [];
  let changed = false;

  config.manager = config.manager || { port: 4000 };
  if (!config.manager.auth) {
    config.manager.auth = { user: 'admin', realm: 'Site Manager' };
  }

  const entries = [['Site Manager', config.manager.auth]];
  for (const site of config.sites) entries.push(...passwords.siteCredentials(site));

  for (const [label, entry] of entries) {
    if ((!entry.pass && !entry.passHash) || passwords.isKnownDefault(entry)) {
      entry.pass = passwords.generatePassword();
      generated.push({ label, user: entry.user, pass: entry.pass });
    }
    if (entry.pass !== undefined) {
      passwords.hashEntry(entry);
      changed = true;
    }
  }

  if (changed) fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  if (generated.length) {
    console.log('\nThese logins had no password or a publicly known default password.');
    console.log('New random passwords were generated. They are shown ONCE — note them now:\n');
    for (const g of generated) console.log(`  ${g.label.padEnd(32)} user: ${g.user.padEnd(10)} pass: ${g.pass}`);
    console.log('\nTo choose your own, put "pass": "your-password" in config.json (or use the Site Manager) and restart;');
    console.log('it will be hashed automatically.\n');
  }
}

// Origins the Site Manager can be viewed on — the only pages allowed to embed sites in its preview pane
function managerOrigins() {
  const { port, host, allowedHosts = [] } = config.manager;
  if (!port) return '';
  // CSP source expressions can't contain IPv6 literals, so only names and IPv4 addresses are listed
  const hosts = new Set(['localhost', '127.0.0.1', ...allowedHosts.map(h => String(h).toLowerCase())]);
  if (host && net.isIPv4(host) && host !== '0.0.0.0') hosts.add(host);
  return [...hosts].filter(h => /^[a-z0-9.-]+$/.test(h)).map(h => `http://${h}:${port}`).join(' ');
}

function createSiteHandler(site) {
  const resolvedSite = { ...site, root: path.resolve(__dirname, site.root) };
  const frameAncestors = managerOrigins();

  return async (req, res) => {
    setSiteHeaders(res, frameAncestors);

    const origWriteHead = res.writeHead.bind(res);
    let statusCode = 200;
    res.writeHead = (code, ...args) => {
      statusCode = code;
      return origWriteHead(code, ...args);
    };
    const origEnd = res.end.bind(res);
    res.end = (...args) => {
      logRequest(site.name, req, statusCode);
      res.end = origEnd;
      return origEnd(...args);
    };

    try {
      const target = resolveFilePath(req.url, resolvedSite);
      if (target.status) return sendStatus(res, target.status, target.urlPath);

      const file = await canonicalize(target);
      if (!(await checkAuth(req, res, pickAuth(site, file.relPath)))) return;

      serveFile(res, file);
    } catch (err) {
      console.error(`[${site.name}] ${err.message}`);
      if (!res.headersSent) sendStatus(res, 500);
    }
  };
}

const stripSecrets = ({ pass, passHash, ...rest }) => rest;

function publicSiteView({ auth, protectedPaths, ...site }) {
  const view = { ...site };
  if (auth) view.auth = stripSecrets(auth);
  if (protectedPaths) view.protectedPaths = protectedPaths.map(stripSecrets);
  return view;
}

const siteManager = {
  config,
  configPath,
  projectDir:    __dirname,
  sitesDir,
  servers:       new Map(), // port (number) → http.Server
  activeTunnels: new Map(), // port (number) → { publicUrl, stop }

  startSite(site) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(createSiteHandler(site));
      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;
      server.once('listening', () => {
        this.servers.set(site.port, server);
        resolve(server);
      });
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[${site.name}] Port ${site.port} is already in use — skipping.`);
        } else {
          console.error(`[${site.name}] Server error: ${err.message}`);
        }
        reject(err);
      });
      server.listen(site.port, site.host);
    });
  },

  stopSite(port) {
    return new Promise((resolve) => {
      const server = this.servers.get(port);
      if (!server) return resolve();
      server.close(() => {
        this.servers.delete(port);
        resolve();
      });
      server.closeAllConnections();
    });
  },

  stopTunnel(port) {
    const tunnel = this.activeTunnels.get(port);
    if (!tunnel) return;
    tunnel.stop();
    this.activeTunnels.delete(port);
  },

  async addSite(site) {
    passwords.hashSiteSecrets(site);
    await this.startSite(site);
    this.config.sites.push(site);
    this.writeConfig();
  },

  async updateSite(oldPort, newSite) {
    passwords.hashSiteSecrets(newSite);
    // A tunnel would otherwise keep exposing whatever ends up on the old port
    if (newSite.port !== oldPort || newSite.paused) this.stopTunnel(oldPort);
    await this.stopSite(oldPort);
    if (!newSite.paused) await this.startSite(newSite);
    const idx = this.config.sites.findIndex(s => s.port === oldPort);
    if (idx !== -1) this.config.sites[idx] = newSite;
    else this.config.sites.push(newSite);
    this.writeConfig();
  },

  // Paused sites don't listen at all, so nothing is served (not even an error page)
  async pauseSite(port) {
    const site = this.config.sites.find(s => s.port === port);
    if (!site) throw new Error(`No site is configured on port ${port}.`);
    this.stopTunnel(port);
    await this.stopSite(port);
    site.paused = true;
    this.writeConfig();
  },

  async resumeSite(port) {
    const site = this.config.sites.find(s => s.port === port);
    if (!site) throw new Error(`No site is configured on port ${port}.`);
    if (!this.servers.has(port)) await this.startSite(site);
    delete site.paused;
    this.writeConfig();
  },

  async removeSite(port) {
    this.stopTunnel(port);
    await this.stopSite(port);
    this.config.sites = this.config.sites.filter(s => s.port !== port);
    this.writeConfig();
  },

  writeConfig() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
  },

  // Passwords (and their hashes) are never sent to the browser
  getSites() {
    return this.config.sites.map(site => ({
      ...publicSiteView(site),
      running:   this.servers.has(site.port),
      tunnelUrl: this.activeTunnels.has(site.port)
        ? this.activeTunnels.get(site.port).publicUrl
        : null,
    }));
  },
};

// Start all sites (errors are non-fatal)
Promise.allSettled(config.sites.filter(s => !s.paused).map(site => siteManager.startSite(site))).then(() => {
  printStartupTable(config.sites);

  if (config.manager.port) {
    const host = config.manager.host || '127.0.0.1';
    createManagerServer(config.manager.port, host, siteManager);
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
    console.log(`Manager UI → http://${shown}:${config.manager.port}`);
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
      console.warn('WARNING: the Site Manager is reachable from other machines. Its login travels unencrypted over plain HTTP.');
    }
  }
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  const allServers = [...siteManager.servers.values()];
  if (allServers.length === 0) return process.exit(0);
  let closed = 0;
  for (const server of allServers) {
    server.close(() => {
      if (++closed === allServers.length) process.exit(0);
    });
  }
  setTimeout(() => process.exit(0), 3000).unref();
});

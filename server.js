'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const { checkAuth }                     = require('./lib/auth');
const { serveFile }                     = require('./lib/fileServer');
const { printStartupTable, logRequest } = require('./lib/logger');
const { createManagerServer }           = require('./lib/manager');

const configPath = path.join(__dirname, 'config.json');

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

for (const site of config.sites) {
  if (!site.name || !site.port || !site.root) {
    console.error(`Invalid site entry (missing name, port, or root): ${JSON.stringify(site)}`);
    process.exit(1);
  }
  if (site.auth && (!site.auth.user || !site.auth.pass)) {
    console.error(`Site "${site.name}" has auth configured but is missing user or pass.`);
    process.exit(1);
  }
}

function createSiteHandler(site) {
  const resolvedRoot = path.resolve(__dirname, site.root);
  const resolvedSite = { ...site, root: resolvedRoot };

  return (req, res) => {
    const authed = checkAuth(req, res, site.auth);
    if (!authed) {
      logRequest(site.name, req, 401);
      return;
    }
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
    serveFile(req, res, resolvedSite);
  };
}

const siteManager = {
  config,
  configPath,
  servers:       new Map(), // port (number) → http.Server
  activeTunnels: new Map(), // port (number) → { publicUrl, stop }

  startSite(site) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(createSiteHandler(site));
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
      server.listen(site.port);
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
    });
  },

  async addSite(site) {
    await this.startSite(site);
    this.config.sites.push(site);
    this.writeConfig();
  },

  async updateSite(oldPort, newSite) {
    await this.stopSite(oldPort);
    try {
      await this.startSite(newSite);
    } catch (err) {
      // New port failed; restart on old config if port unchanged, else leave stopped
      throw err;
    }
    const idx = this.config.sites.findIndex(s => s.port === oldPort);
    if (idx !== -1) this.config.sites[idx] = newSite;
    else this.config.sites.push(newSite);
    this.writeConfig();
  },

  async removeSite(port) {
    await this.stopSite(port);
    this.config.sites = this.config.sites.filter(s => s.port !== port);
    this.writeConfig();
  },

  writeConfig() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
  },

  getSites() {
    return this.config.sites.map(site => ({
      ...site,
      running:   this.servers.has(site.port),
      tunnelUrl: this.activeTunnels.has(site.port)
        ? this.activeTunnels.get(site.port).publicUrl
        : null,
    }));
  },
};

// Start all sites (errors are non-fatal)
Promise.allSettled(config.sites.map(site => siteManager.startSite(site))).then(() => {
  printStartupTable(config.sites);

  if (config.manager && config.manager.port) {
    createManagerServer(config.manager.port, siteManager);
    console.log(`Manager UI → http://localhost:${config.manager.port}`);
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

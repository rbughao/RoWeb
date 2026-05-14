'use strict';

const fs   = require('fs');
const path = require('path');
const { getMime } = require('./mimeTypes');

function serveFile(req, res, siteConfig) {
  const urlPath = req.url.split('?')[0];

  if (urlPath.includes('..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  const filePath = urlPath === '/' || urlPath === ''
    ? path.resolve(siteConfig.root, siteConfig.index || 'index.html')
    : path.resolve(siteConfig.root, urlPath.replace(/^\//, ''));

  // Ensure resolved path stays within the site root
  const resolvedRoot = path.resolve(siteConfig.root);
  if (!filePath.startsWith(resolvedRoot)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>
<h1>404 Not Found</h1><p>The requested path <code>${escapeHtml(urlPath)}</code> was not found.</p>
</body></html>`);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`500 Internal Server Error: ${err.message}`);
      }
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': getMime(ext) });
    res.end(data);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { serveFile };

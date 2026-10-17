'use strict';

const fs   = require('fs');
const path = require('path');
const { getMime } = require('./mimeTypes');

// Maps a request URL to a file under site.root. Returns { status } on rejection.
function resolveFilePath(reqUrl, site) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((reqUrl || '/').split('?')[0]);
  } catch {
    return { status: 400 };
  }
  if (urlPath.includes('..') || urlPath.includes('\0')) return { status: 403 };

  const root = path.resolve(site.root);
  const rel  = urlPath.replace(/^[\\/]+/, '');
  const filePath = rel === ''
    ? path.join(root, site.index || 'index.html')
    : path.resolve(root, rel);

  if (filePath !== root && !filePath.startsWith(root + path.sep)) return { status: 403 };
  return { urlPath, filePath, root };
}

// The URL-style path of the file relative to the site root, using the on-disk canonical
// name when the file exists (defeats case, 8.3 short-name and trailing-dot tricks on Windows).
async function canonicalRelPath({ filePath, root }) {
  const toUrl = rel => '/' + rel.split(path.sep).join('/');
  try {
    const [real, realRoot] = await Promise.all([fs.promises.realpath(filePath), fs.promises.realpath(root)]);
    const rel = path.relative(realRoot, real);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return toUrl(rel);
  } catch {}
  return toUrl(path.relative(root, filePath));
}

function sendStatus(res, status) {
  const text = { 400: '400 Bad Request', 403: '403 Forbidden' }[status] || String(status);
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(text);
}

function serveFile(res, { urlPath, filePath }) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        const body = `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>
<h1>404 Not Found</h1><p>The requested path <code>${escapeHtml(urlPath)}</code> was not found.</p>
</body></html>`;
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      } else {
        console.error(`File read error for ${filePath}: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
      return;
    }

    res.writeHead(200, {
      'Content-Type':   getMime(path.extname(filePath)),
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { resolveFilePath, canonicalRelPath, serveFile, sendStatus };

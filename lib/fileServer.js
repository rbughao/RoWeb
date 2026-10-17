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

  // Hidden files (.git, .env, .htpasswd…) are never served; .well-known is standard and allowed
  const hidden = urlPath.split(/[\\/]/).some(seg => seg.startsWith('.') && seg !== '.well-known');
  if (hidden) return { status: 404, urlPath };

  const root = path.resolve(site.root);
  const rel  = urlPath.replace(/^[\\/]+/, '');
  const filePath = rel === ''
    ? path.join(root, site.index || 'index.html')
    : path.resolve(root, rel);

  if (filePath !== root && !filePath.startsWith(root + path.sep)) return { status: 403 };
  return { urlPath, filePath, root };
}

// Resolves the canonical on-disk file (defeats case, 8.3 short-name, ADS and trailing-dot
// tricks on Windows). relPath is what auth rules are matched against; realFile is the ONLY
// path that will be read, so the checked path and the served path can never differ.
async function canonicalize(target) {
  const toUrl = rel => '/' + rel.split(path.sep).join('/');
  try {
    const [real, realRoot] = await Promise.all([fs.promises.realpath(target.filePath), fs.promises.realpath(target.root)]);
    const rel = path.relative(realRoot, real);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { ...target, relPath: toUrl(rel), realFile: real };
    }
  } catch {}
  // Missing, or a symlink escaping the root: match rules on the logical path, serve nothing
  return { ...target, relPath: toUrl(path.relative(target.root, target.filePath)), realFile: null };
}

// Returns an error message if `root` isn't a dedicated folder inside sitesDir, else null.
function rootProblem(root, { projectDir, sitesDir, otherRoots = [] }) {
  const real = p => { try { return fs.realpathSync.native(p); } catch { return p; } };
  const norm = p => {
    const r = real(path.resolve(projectDir, p));
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const inside = (child, parent) => child.startsWith(parent + path.sep);

  const base = norm(sitesDir);
  const abs  = norm(root);
  if (!inside(abs, base)) {
    return `Root directory must be a folder inside ${sitesDir} (e.g. ${sitesDir.replace(/\/?$/, '/')}mysite).`;
  }
  for (const other of otherRoots) {
    const o = norm(other);
    if (o === abs || inside(abs, o) || inside(o, abs)) {
      return `Root directory overlaps with another site's folder (${other}) — that would bypass its login.`;
    }
  }
  return null;
}

const NOT_FOUND = urlPath => `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>
<h1>404 Not Found</h1><p>The requested path <code>${escapeHtml(urlPath)}</code> was not found.</p>
</body></html>`;

function send404(res, urlPath) {
  const body = NOT_FOUND(urlPath || '/');
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendStatus(res, status, urlPath) {
  if (status === 404) return send404(res, urlPath);
  const text = { 400: '400 Bad Request', 403: '403 Forbidden', 500: '500 Internal Server Error' }[status] || String(status);
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(text);
}

function serveFile(res, { urlPath, realFile }) {
  if (!realFile) return send404(res, urlPath);

  fs.readFile(realFile, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') return send404(res, urlPath);
      console.error(`File read error for ${realFile}: ${err.message}`);
      return sendStatus(res, 500);
    }
    res.writeHead(200, {
      'Content-Type':   getMime(path.extname(realFile)),
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { resolveFilePath, canonicalize, rootProblem, serveFile, sendStatus };

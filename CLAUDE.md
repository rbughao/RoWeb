# Multi-Port Web Server with Per-Site Password Authentication

## Project Overview

Build a **Node.js multi-port web server** that:
- Hosts different HTML pages/sites on separate configurable ports
- Supports **per-site HTTP Basic Authentication** (browser native password prompt)
- Is fully config-driven via a single `config.json` file
- Requires zero dependencies beyond Node.js built-ins (no npm install needed)
- Provides a clean CLI startup log showing all active sites and their auth status

---

## Functional Requirements

### 1. Config-Driven Architecture

All sites are defined in `config.json` at the project root. Each entry defines:

| Field        | Type      | Required | Description                                              |
|--------------|-----------|----------|----------------------------------------------------------|
| `name`       | string    | Yes      | Human-readable site name (shown in logs)                 |
| `port`       | number    | Yes      | Port to bind this site to                                |
| `root`       | string    | Yes      | Relative path to the folder containing this site's files |
| `index`      | string    | No       | Entry HTML file (default: `index.html`)                  |
| `auth`       | object    | No       | If present, enables HTTP Basic Auth for this site        |
| `auth.user`  | string    | Yes*     | Username for Basic Auth                                  |
| `auth.pass`  | string    | Yes*     | Password for Basic Auth                                  |
| `auth.realm` | string    | No       | Browser prompt label (default: site name)                |

**Example `config.json`:**

```json
{
  "sites": [
    {
      "name": "Public Home",
      "port": 3000,
      "root": "./sites/home"
    },
    {
      "name": "Admin Dashboard",
      "port": 3001,
      "root": "./sites/admin",
      "auth": {
        "user": "admin",
        "pass": "secret123",
        "realm": "Admin Area"
      }
    },
    {
      "name": "Internal Wiki",
      "port": 3002,
      "root": "./sites/wiki",
      "index": "wiki.html",
      "auth": {
        "user": "team",
        "pass": "wiki2024"
      }
    }
  ]
}
```

---

### 2. HTTP Basic Authentication

- When `auth` is defined for a site, ALL requests to that port must include valid `Authorization: Basic <base64>` credentials
- If credentials are missing or wrong, respond with:
  - Status: `401 Unauthorized`
  - Header: `WWW-Authenticate: Basic realm="<realm>"` — this triggers the **native browser password dialog**
  - Body: `401 Unauthorized` plain text
- Credentials are validated against the config (no sessions, stateless per-request)
- Auth applies to **every file** served on that port (HTML, CSS, JS, images, etc.)

**Auth Flow:**
```
Browser Request
      │
      ▼
Has Authorization header? ──No──▶ Send 401 + WWW-Authenticate → Browser shows dialog
      │
     Yes
      │
      ▼
Credentials match config? ──No──▶ Send 401 + WWW-Authenticate → Browser shows dialog
      │
     Yes
      │
      ▼
Serve requested file normally
```

---

### 3. Static File Server

Each site port serves static files from its configured `root` directory:

- `GET /` → serves `index.html` (or configured `index` file)
- `GET /about.html` → serves `<root>/about.html`
- `GET /css/style.css` → serves `<root>/css/style.css`
- MIME types must be set correctly for: `.html`, `.css`, `.js`, `.json`, `.png`, `.jpg`, `.gif`, `.svg`, `.ico`, `.woff`, `.woff2`, `.ttf`
- `404 Not Found` with a clean HTML error page if file doesn't exist
- `500 Internal Server Error` with message if file read fails
- **Directory traversal protection**: reject any path containing `..`

---

### 4. Startup CLI Output

On launch, print a formatted table to stdout:

```
╔══════════════════════════════════════════════════════╗
║          Multi-Port Web Server — Started             ║
╠══════════════════════════════════════════════════════╣
║  Public Home        http://localhost:3000   [open]   ║
║  Admin Dashboard    http://localhost:3001   [auth]   ║
║  Internal Wiki      http://localhost:3002   [auth]   ║
╚══════════════════════════════════════════════════════╝
Press Ctrl+C to stop all servers.
```

- `[open]` = no auth required (green if terminal supports color)
- `[auth]` = password protected (yellow if terminal supports color)

---

## Project Structure to Generate

```
/
├── CLAUDE.md               ← this file
├── config.json             ← site definitions (create with 3 example sites)
├── server.js               ← main entry point
├── lib/
│   ├── auth.js             ← Basic Auth middleware logic
│   ├── fileServer.js       ← static file serving logic
│   ├── logger.js           ← startup table printer + request logger
│   └── mimeTypes.js        ← MIME type map
└── sites/
    ├── home/
    │   └── index.html      ← sample public page
    ├── admin/
    │   └── index.html      ← sample protected admin page
    └── wiki/
        └── wiki.html       ← sample protected wiki page
```

---

## Implementation Instructions

### `server.js` (Entry Point)

```
1. Read and parse config.json
2. Validate config: each site must have name, port, root; auth sites must have user+pass
3. For each site in config.sites:
   a. Create an http.Server instance
   b. On each request: run auth check (if configured), then serve static file
   c. Listen on the configured port
4. Print startup table via logger
5. Handle SIGINT (Ctrl+C) to gracefully close all servers
```

### `lib/auth.js`

```javascript
// Exports: checkAuth(req, res, authConfig) → boolean
// - Returns true if auth passes or no auth configured
// - Returns false and sends 401 response if auth fails
// - Parses Authorization header: "Basic <base64(user:pass)>"
// - Uses Buffer.from(encoded, 'base64').toString('utf8').split(':')
// - Constant-time comparison to prevent timing attacks (use crypto.timingSafeEqual)
```

### `lib/fileServer.js`

```javascript
// Exports: serveFile(req, res, siteConfig)
// - Resolve URL path to filesystem path under siteConfig.root
// - Block directory traversal (paths containing '..')
// - Default '/' to siteConfig.index or 'index.html'
// - Read file with fs.readFile
// - Set Content-Type from mimeTypes map
// - Send 404 or 500 on errors
```

### `lib/mimeTypes.js`

```javascript
// Exports: getMime(ext) → string
// Map of extensions to MIME types
// Default to 'application/octet-stream' for unknown types
```

### `lib/logger.js`

```javascript
// Exports:
//   printStartupTable(sites)  → prints the bordered table on launch
//   logRequest(name, req, statusCode) → prints per-request log line
//     Format: [SiteName] GET /path → 200  (timestamp)
```

---

## Sample Site Pages

### `sites/home/index.html`
A clean, welcoming public landing page. Include:
- A heading: "Welcome to the Multi-Port Server"
- A short paragraph explaining the server
- A list of available ports (can be static placeholders)
- Minimal inline CSS — clean and readable

### `sites/admin/index.html`
A protected admin dashboard page. Include:
- Heading: "Admin Dashboard"
- A notice: "You are authenticated as an administrator."
- Placeholder cards for: Users, Settings, Logs
- Slightly more styled than the home page

### `sites/wiki/wiki.html`
A protected internal wiki page. Include:
- Heading: "Internal Wiki"
- A notice: "Team access only."
- A few placeholder wiki sections with headings and paragraph text

---

## Non-Functional Requirements

- **Zero external dependencies** — use only Node.js built-ins (`http`, `fs`, `path`, `crypto`, `os`)
- **No npm required** — run directly with `node server.js`
- **Graceful shutdown** — all servers close cleanly on SIGINT
- **Error resilience** — if one port fails to bind (e.g., already in use), log the error and continue starting the others
- **Node.js version** — compatible with Node.js 18+

---

## How to Run

After generating the project:

```bash
node server.js
```

To test auth in terminal:
```bash
# Should return 401
curl -i http://localhost:3001/

# Should return 200 with HTML
curl -i -u admin:secret123 http://localhost:3001/
```

---

## Validation Checklist

Before marking complete, verify:

- [ ] `node server.js` starts without errors
- [ ] `http://localhost:3000` loads the home page in browser (no auth prompt)
- [ ] `http://localhost:3001` triggers the browser's native login dialog
- [ ] Wrong credentials on port 3001 re-show the dialog
- [ ] Correct credentials on port 3001 show the admin dashboard
- [ ] `http://localhost:3002` requires auth with different credentials
- [ ] `curl -i http://localhost:3001/` returns `401` and `WWW-Authenticate` header
- [ ] Requesting a missing file returns a `404` page
- [ ] A path with `../` is rejected with `403 Forbidden`
- [ ] Startup table prints cleanly with correct port and auth status per site
- [ ] `Ctrl+C` stops all servers gracefully

---

## Extension Ideas (Optional Enhancements)

Claude Code may implement these if time permits or if asked:

1. **Hot-reload config** — watch `config.json` for changes and restart affected sites
2. **HTTPS support** — add optional `tls` block per site with `cert` and `key` paths
3. **Request logging to file** — write access logs to `logs/<sitename>.log`
4. **Admin API port** — a special port that lists all running sites as JSON
5. **Rate limiting** — track failed auth attempts per IP and temporarily block after N failures

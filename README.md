# RoWeb — Multi-Port Web Server

A zero-dependency Node.js web server that hosts multiple static sites on separate ports, each with optional password protection, a browser-based management UI, and a built-in reverse proxy tunnel system for exposing local sites to the public internet.

**No npm install required. Runs with `node server.js`.**

---

## Table of Contents

1. [Features](#features)
2. [Requirements](#requirements)
3. [Project Structure](#project-structure)
4. [Quick Start](#quick-start)
5. [Configuration](#configuration)
6. [Site Manager UI](#site-manager-ui)
   - [Pausing a site](#pausing-a-site)
7. [Password Protection & Rate Limiting](#password-protection--rate-limiting)
   - [Protecting Specific URLs](#protecting-specific-urls)
8. [**Put Your Sites on the Internet (Step by Step)**](#put-your-sites-on-the-internet-step-by-step)
   - [Part 1 — One-time setup](#part-1--one-time-setup)
   - [Part 2 — Put a site online](#part-2--put-a-site-online)
9. [Tunnel System](#tunnel-system)
   - [How It Works](#how-it-works)
   - [Step 1 — Configure via Site Manager](#step-1--configure-via-site-manager)
   - [Step 2 — Deploy the Tunnel Server on Your VPS](#step-2--deploy-the-tunnel-server-on-your-vps)
   - [Step 3 — Create a Tunnel](#step-3--create-a-tunnel)
10. [Hosting the Tunnel on AWS, Google Cloud or GoDaddy](#hosting-the-tunnel-on-aws-google-cloud-or-godaddy)
   - [Option A — AWS](#option-a--aws-ec2--route-53)
   - [Option B — Google Cloud](#option-b--google-cloud-compute-engine--cloud-dns)
   - [Option C — GoDaddy](#option-c--godaddy-domain--dns-optional-vps)
   - [Finish the server setup (all providers)](#finish-the-server-setup-all-providers)
   - [Connect your PC](#connect-your-pc)
   - [Check it works & troubleshooting](#check-it-works--troubleshooting)
11. [Running in Production](#running-in-production)
12. [Security Notes](#security-notes)
13. [Passwords & First Run](#passwords--first-run)

---

## Features

| Feature | Details |
|---|---|
| **Multi-port hosting** | Each site runs on its own port, fully isolated |
| **Per-site Basic Auth** | Browser-native login dialog, configured per site |
| **Per-URL logins** | Require a browser login only on specific paths (e.g. `/reports`) |
| **Rate limiting** | 5 failed attempts → 10-minute lockout per IP per site, survives restarts |
| **Hashed passwords** | Stored as scrypt hashes; default or missing passwords are replaced with random ones on startup |
| **Live Site Manager** | Add, edit, pause, resume and delete sites from a browser UI without restarting, with a live preview of the selected site |
| **Reverse proxy tunnels** | Expose any local site to the internet via a secure public URL |
| **Tunnel Config UI** | Set your domain, certs, and token from the browser — no file editing |
| **Zero dependencies** | Only Node.js built-ins (`http`, `https`, `fs`, `net`, `tls`, `crypto`) |

---

## Requirements

- **Node.js 18 or newer**
- No npm, no package.json, no installs

---

## Project Structure

```
roweb/
├── server.js               ← Main entry point
├── config.example.json     ← Template site definitions (committed)
├── config.json             ← Your real config — created on first run, gitignored
├── lib/
│   ├── auth.js             ← HTTP Basic Auth + rate limiting
│   ├── fileServer.js       ← Static file serving
│   ├── logger.js           ← Startup table + request logs
│   ├── manager.js          ← Site Manager API server
│   ├── mimeTypes.js        ← MIME type map
│   ├── passwords.js        ← scrypt password hashing
│   └── securityHeaders.js  ← Security response headers
├── data/                   ← Persisted lockouts (created at runtime, gitignored)
├── tunnel/
│   ├── server.js           ← Tunnel server (deploy on VPS)
│   ├── client.js           ← Tunnel client (runs locally)
│   ├── protocol.js         ← Shared binary frame protocol
│   └── tunnel-config.json  ← Tunnel settings (gitignored)
└── sites/
    ├── home/               ← Sample public site (port 3000)
    ├── admin/              ← Sample protected site (port 3001)
    ├── wiki/               ← Sample protected site (port 3002)
    └── manager/            ← Site Manager UI (port 4000)
```

---

## Quick Start

**1. Clone the repository**

```bash
git clone https://github.com/rbughao/RoWeb.git
cd RoWeb
```

**2. Start the server**

```bash
node server.js
```

On the first run, `config.json` is created from `config.example.json`, and a **random password is generated for every login**. They're printed **once**, so copy them now:

```
Created config.json from config.example.json.

These logins had no password or a publicly known default password.
New random passwords were generated. They are shown ONCE — note them now:

  Site Manager                     user: admin      pass: <random-16-chars>
  Admin Dashboard                  user: admin      pass: <random-16-chars>
  Internal Wiki                    user: team       pass: <random-16-chars>

╔═════════════════════════════════════════════════════╗
║           Multi-Port Web Server — Started           ║
╠═════════════════════════════════════════════════════╣
║  Public Home      http://localhost:3000     [open]  ║
║  Admin Dashboard  http://localhost:3001     [auth]  ║
║  Internal Wiki    http://localhost:3002     [auth]  ║
╚═════════════════════════════════════════════════════╝
Press Ctrl+C to stop all servers.
Manager UI → http://127.0.0.1:4000
```

Lost them, or want your own? See [Passwords & First Run](#passwords--first-run).

**3. Open the Site Manager**

Navigate to [http://127.0.0.1:4000](http://127.0.0.1:4000) and log in as `admin` with the Site Manager password from the console. See [Site Manager UI](#site-manager-ui) for a walkthrough.

> The manager only listens on `127.0.0.1`, so it can only be opened from this computer. Use `127.0.0.1` rather than `localhost` — on Windows, `localhost` tries IPv6 first and each request waits about 200 ms before falling back.

---

## Configuration

All sites are defined in `config.json` at the project root. It's created from `config.example.json` on first run and is **gitignored**, so your settings and password hashes never end up on GitHub.

```json
{
  "sitesDir": "./sites",
  "manager": {
    "port": 4000,
    "host": "127.0.0.1",
    "auth": { "user": "admin", "realm": "Site Manager" }
  },
  "sites": [
    { "name": "Public Home", "port": 3000, "root": "./sites/home" },
    {
      "name": "Admin Dashboard",
      "port": 3001,
      "root": "./sites/admin",
      "auth": { "user": "admin", "pass": "my-new-password", "realm": "Admin Area" }
    }
  ]
}
```

To set a password by hand, write it as `"pass"` (like the Admin Dashboard above) and restart. On startup it's replaced with a `"passHash"` (scrypt), so the plaintext never stays on disk.

### Site fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Human-readable label shown in logs and UI |
| `port` | Yes | Port to bind this site to |
| `root` | Yes | Folder with the site's files. Must be **inside `sitesDir`** and must not overlap another site's folder, since that would let one site serve another's files without its login |
| `index` | No | Entry file (default: `index.html`) |
| `host` | No | Address to listen on. Default: all interfaces. Use `"127.0.0.1"` to keep a site private to this computer |
| `tunnel.subdomain` | No | Fixed public address for the tunnel, e.g. `"tunnel": { "subdomain": "qrcoder" }` → `https://qrcoder.yourdomain.com`. Letters, numbers and hyphens; unique per site. Also settable in the Site Manager (**Tunnel address**) |
| `paused` | No | `true` = the site isn't served at all (its port isn't opened). Usually set with the **Pause** button rather than by hand |
| `auth.user` | If auth | Username for Basic Auth |
| `auth.pass` | If auth | Password (hashed automatically on startup; at least 8 characters when set from the UI) |
| `auth.realm` | No | Label shown in the browser's login dialog |
| `protectedPaths` | No | List of URL-specific logins — see [Protecting Specific URLs](#protecting-specific-urls) |

### Top-level and manager fields

| Field | Required | Description |
|---|---|---|
| `sitesDir` | No | Folder all site roots must live in. Default `./sites`. Only editable in this file, not from the UI |
| `manager.port` | Yes | Port for the Site Manager UI |
| `manager.host` | No | Address the manager listens on. Default `127.0.0.1` (this computer only). Setting `0.0.0.0` exposes it to your network over plain HTTP, which isn't recommended |
| `manager.auth` | Yes | Login for the Site Manager. If missing, it's created with a random password |
| `manager.allowedHosts` | No | Extra hostnames allowed to reach the manager, e.g. `["myserver.lan"]`. `localhost` and IP addresses always work. Anything else gets `403` (blocks DNS-rebinding attacks) |

> **Tip:** You can also manage all of this from the Site Manager UI — changes take effect immediately without restarting.

---

## Site Manager UI

Open [http://127.0.0.1:4000](http://127.0.0.1:4000) in your browser.

The screen has two parts:

**Site list (left).** Each site is a card. Click a card (or Tab to it and press Enter) to focus on it.
- **Green dot / `running`**: the site's server is listening on its port
- **`open`** or **`auth`**: whether the whole site needs a login
- **`N protected URLs`**: how many paths have their own login (hover to see them)
- **Grey dot / `⏸ paused`**: the site is paused and not being served
- **`tunnel on`**: a public tunnel is active
- The selected site's buttons (**Tunnel**, **Pause**/**Resume**, **Edit**, **Delete**) appear under it; other sites show theirs when you hover over them
- **Tunnel Config dot**: grey = tunnel not configured yet, green = ready

**Live preview (right).** It shows the focused site as visitors see it, with its address, its public tunnel URL when one is active, **↻ Reload** and **Open ↗** (open in a new tab).
- The manager remembers which site you were looking at
- After you add or edit a site, the preview switches to it and reloads, so your changes show at once
- For a password-protected site (**🔒 login**), your browser asks for that site's login inside the preview. If no prompt appears, click **Open ↗**, log in there, then **↻ Reload**
- On a narrow screen the list sits on top and the preview below it

![Site Manager dashboard](docs/screenshots/01-dashboard.png)

### Adding a site (step by step)

1. Create a folder for the site's files **inside `sites/`**, e.g. `sites/blog/`, and put an `index.html` in it
2. Click **+ Add Site**
3. Fill in **Site Name**, a free **Port** (e.g. `3005`) and the **Root Directory** (`./sites/blog`)
4. *(Optional)* Turn on **Password Protection** to put the whole site behind a login, then set a username, a password of at least 8 characters, and a realm (the label shown in the browser's login box)
5. *(Optional)* Click **+ Add URL** to protect only certain paths. See [Protecting Specific URLs](#protecting-specific-urls)
6. Click **Add Site**. The site starts right away at `http://localhost:3005`, with no restart needed

![Add Site form with password protection enabled](docs/screenshots/02-add-site.png)

### What you can do

| Action | How |
|---|---|
| **Add a site** | Click **+ Add Site**, fill in name, port, root directory, and optionally enable password protection |
| **Edit a site** | Click **Edit** on any site card — the server on that port restarts with new settings |
| **Pause a site** | Click **⏸ Pause**. See [Pausing a site](#pausing-a-site) |
| **Resume a site** | Click **▶ Resume** on the site's card in the list |
| **Delete a site** | Click **Delete** — stops the server and removes it from config |
| **Toggle auth** | Use the toggle switch in the Add/Edit form to enable or disable password protection |
| **Protect a specific URL** | In the Add/Edit form, click **+ Add URL** under *Protected URLs* |
| **Change a password** | Type a new one in Edit. Leave it blank to keep the current password — passwords are never sent back to the browser |
| **Create a tunnel** | Click **🔗 Tunnel** on any site card to expose it to the internet |
| **Stop a tunnel** | Click **Stop Tunnel** on the active card |
| **Configure tunnel** | Click **Tunnel Config** in the toolbar |

### Pausing a site

Pausing takes a site offline without deleting it — handy for maintenance, or to hide a site for a while.

1. Select the site and click **⏸ Pause**
2. The site stops listening on its port, so nothing is served: no pages, no error page. Visitors' browsers just can't connect. Any active tunnel for it is closed
3. The card turns grey with a **⏸ paused** badge, and the preview shows **This site is paused**
4. Click **▶ Resume** on the site's card to serve it again. Pausing and resuming are only possible from the Site Manager, behind its admin login. Visitors to a paused site can't reach anything: the port is closed

![A paused site in the Site Manager](docs/screenshots/05-paused-site.png)

The paused state is saved to `config.json` (`"paused": true`). A paused site **stays paused after a restart**, and the startup table shows it as `[paused]`. Editing a paused site keeps it paused. While a site is paused, its port stays reserved for it in the manager.

If another program grabs the port while the site is paused, **Resume** reports that the port is in use; edit the site to choose another port.

---

## Password Protection & Rate Limiting

### Enabling auth on a site

Add an `auth` block to the site in `config.json`, or toggle **Password Protection** in the Site Manager UI:

```json
"auth": {
  "user": "myuser",
  "pass": "mypassword",
  "realm": "My Protected Site"
}
```

When a browser accesses a protected site it shows the native login dialog. All files on that port — HTML, CSS, images, everything — require valid credentials.

### Rate limiting

To prevent brute-force attacks, failed login attempts are tracked **per client per port**:

- After **5 failed attempts**, that client is locked out for **10 minutes**
- A "client" is one IPv4 address, or a whole IPv6 **/64** block (one user typically controls millions of addresses in a /64)
- If a site gets **100 failed attempts in 10 minutes from all clients combined** (e.g. a botnet), new logins on that site are paused for 10 minutes. People who already logged in successfully keep working
- The lockout countdown is sent in the `Retry-After` response header
- A successful login resets the counter
- Lockouts are saved to `data/login-attempts.json`, so restarting the server doesn't clear them
- Tunnelled visitors are tracked by their real public IP. The tunnel server overwrites `X-Forwarded-For`, and when another proxy (nginx, Caddy) sits in front, only the last address — the one your proxy added — is trusted

```
HTTP/1.1 429 Too Many Requests
Retry-After: 600
```

### Protecting Specific URLs

You can require a browser login on specific paths only — for example, keep a site public but lock down `/reports`.

**From the Site Manager:**

1. Click **Edit** on the site
2. Under **Protected URLs**, click **+ Add URL** (once per path)
3. Enter the **URL path** (e.g. `/reports`), a **username**, a **password**, and optionally a **realm**
4. Click **Save Changes**. It takes effect immediately; visiting that URL now pops up the browser's login box

When editing an existing rule, leave the password blank to keep the current one. Click **Remove** to delete a rule.

![Protected URLs in the Edit Site form](docs/screenshots/03-protected-urls.png)

**From `config.json`:**

```json
{
  "name": "Public Home",
  "port": 3000,
  "root": "./sites/home",
  "protectedPaths": [
    { "path": "/reports", "user": "boss",   "pass": "reportpw", "realm": "Reports" },
    { "path": "/private/notes.html", "user": "me", "pass": "notespw" }
  ]
}
```

How rules are matched:

| Rule | Protects |
|---|---|
| `/reports` | `/reports`, `/reports/`, `/reports/q1.html`, `/reports/2026/summary.pdf`, … |
| `/private/notes.html` | Only that one file |
| `/` | The whole site |

- Matching is **case-insensitive** and works on the real file path, so tricks like `/REPORTS`, `/%72eports` or `/./reports` can't bypass a rule.
- If several rules match, the **most specific (longest) path wins**.
- A matching rule **replaces** the site-wide login for those URLs (a browser can only send one login per request), so you can give different people access to different areas.
- Rate limiting applies to URL logins too.

---

## Put Your Sites on the Internet (Step by Step)

Out of the box your sites can only be opened on your own computer and home network. A **tunnel** gives a site a public, secure address, for example `https://qrcoder.yourdomain.com`, that anyone can open from anywhere. You don't open any ports on your home router.

```
Visitor's browser ──HTTPS──▶ your small cloud server ──encrypted tunnel──▶ RoWeb on your PC ──▶ your site
```

There are two parts: a **one-time setup** (about an hour), then **one click per site** whenever you want it online.

### What you need

| Item | Notes |
|---|---|
| **A domain name** | e.g. `yourdomain.com`, from any registrar: GoDaddy, Namecheap, Cloudflare, AWS Route 53, Squarespace… |
| **A small Linux server with a public IP** | The smallest size from AWS, Google Cloud, a GoDaddy VPS, DigitalOcean, Hetzner… is plenty. It only relays traffic. |
| **Your PC, switched on, running RoWeb** | Your sites still live on your PC. If it's off or asleep, visitors see "No active tunnel". |

---

### Part 1 — One-time setup

Do these once. Each step links to detailed instructions for **AWS**, **Google Cloud** and **GoDaddy**.

**Step 1 — Get a domain.** Buy one from any registrar. If you already own one, use it.

**Step 2 — Rent a small server.** Choose **Ubuntu 24.04 LTS** and give it a **fixed (static) IP**. Open ports **22** (SSH, only from your own IP), **80**, **443** and **7000** in its firewall.
→ [AWS](#option-a--aws-ec2--route-53) (steps 1–2) · [Google Cloud](#option-b--google-cloud-compute-engine--cloud-dns) (steps 1–2) · [GoDaddy VPS](#option-c--godaddy-domain--dns-optional-vps) (step 1)

**Step 3 — Point your domain at the server.** In your domain's DNS settings, create two **A** records, both with the server's IP as the value:

| Name | Type | Value |
|---|---|---|
| `@` (the domain itself) | A | your server's IP |
| `*` (every subdomain) | A | your server's IP |

→ [Route 53](#option-a--aws-ec2--route-53) (step 3) · [Cloud DNS](#option-b--google-cloud-compute-engine--cloud-dns) (step 3) · [GoDaddy DNS](#option-c--godaddy-domain--dns-optional-vps) (step 2)

Check it from your PC: `nslookup test.yourdomain.com` should answer with your server's IP. It can take a few minutes, sometimes up to an hour.

**Step 4 — Get a free HTTPS certificate** covering both `yourdomain.com` and `*.yourdomain.com`, from Let's Encrypt using `certbot` on the server.
→ [AWS](#option-a--aws-ec2--route-53) (steps 4–5, renews automatically) · [Google Cloud](#option-b--google-cloud-compute-engine--cloud-dns) (steps 4–5, renews automatically) · [GoDaddy](#option-c--godaddy-domain--dns-optional-vps) (step 3, renewed by hand)

**Step 5 — Install the tunnel server** on the server as an always-on service.
→ [Finish the server setup](#finish-the-server-setup-all-providers)

**Step 6 — Connect RoWeb to it.** On your PC, open the Site Manager ([http://127.0.0.1:4000](http://127.0.0.1:4000)) → **Tunnel Config** and fill in:
- **Domain** and **Server Host:** `yourdomain.com`
- **TLS Certificate File:** `/etc/letsencrypt/live/yourdomain.com/fullchain.pem`
- **TLS Key File:** `/etc/letsencrypt/live/yourdomain.com/privkey.pem`
- **Shared Token:** click **Generate**
- **TLS on control connection:** **on**; **Allow self-signed certificate:** **off**

Click **Save Config**, copy `tunnel\tunnel-config.json` to the server and start the service.
→ [Connect your PC](#connect-your-pc) (exact copy and start commands for each provider)

✅ **Check:** open `https://test.yourdomain.com` in a browser. A padlock plus the page **"502 — No active tunnel"** means the setup is complete: everything works, and no site is online yet. Not seeing that? See [troubleshooting](#check-it-works--troubleshooting).

---

### Part 2 — Put a site online

Do this whenever you want a site on the internet.

1. **Start RoWeb** on your PC (`node server.js` in the RoWeb folder) and open the Site Manager at [http://127.0.0.1:4000](http://127.0.0.1:4000).
2. **Choose its public address** (recommended). Click the site → **Edit** → **Tunnel address**, e.g. `qrcoder`. The form shows the resulting link, `https://qrcoder.yourdomain.com`. Click **Save Changes**. Without an address, the site gets a random one such as `https://a3f9c1b2.yourdomain.com`.
3. **Decide who may see it.** Anyone with the link can open a tunnelled site. For a private site, turn on **Password Protection**, or protect specific pages with **Protected URLs**, *before* you open the tunnel.
4. **Click 🔗 Tunnel** on the site's card. The card shows **🔗 tunnel on**, and the public link appears in the preview bar.
5. **Test it from outside.** Open the link on your phone using **mobile data** (Wi-Fi off), so you know it works for people outside your home.
6. **Share the link.**

**To take a site offline:**
- **Stop Tunnel:** the site disappears from the internet but keeps working on your PC.
- **⏸ Pause:** the site stops completely, both locally and publicly.

### Good to know

- **Your PC must stay on.** If it sleeps, shuts down, or RoWeb is closed, visitors get "No active tunnel". For sites that must always be up, set your PC to never sleep, or run RoWeb on an always-on machine.
- **After restarting RoWeb, tunnels are off.** Click **🔗 Tunnel** again. With a fixed tunnel address the link stays the same, so links you've shared keep working.
- **Short internet drops fix themselves.** The tunnel reconnects automatically and keeps the same address.
- **Each site needs its own address.** Two sites can't use the same tunnel address.
- **The Site Manager itself can never be tunnelled.** It stays reachable only from your PC.
- **Logins are protected.** Rate limiting and lockouts apply to visitors coming through the tunnel too, using each visitor's real IP.

---

## Tunnel System

The tunnel system lets you share any locally running site with anyone on the internet using a secure public URL like `https://a3f9c1b2.yourdomain.com`.

### How It Works

```
Public User
    │  HTTPS  → a3f9c1b2.yourdomain.com
    ▼
Tunnel Server (your VPS)
    │  persistent TLS-encrypted connection (port 7000)
    ▼
Tunnel Client (your local machine)
    │  HTTP  → localhost:3001
    ▼
Local Site (running via server.js)
```

### Prerequisites

You need:
- A **VPS** (DigitalOcean, Hetzner, Linode, etc.) with a public IP address
- A **domain name** with a **wildcard DNS record**: `*.yourdomain.com → VPS IP`
- A **TLS certificate** covering **both** `yourdomain.com` and `*.yourdomain.com`. The wildcard serves visitors, and the plain domain secures the control connection your PC makes. [Let's Encrypt](https://letsencrypt.org/) is free; wildcards need the DNS challenge:
  ```bash
  sudo certbot certonly --manual --preferred-challenges dns -d yourdomain.com -d '*.yourdomain.com'
  ```
- Ports **80**, **443**, and **7000** open on your VPS firewall

---

### Step 1 — Configure via Site Manager

1. Open the Site Manager at [http://127.0.0.1:4000](http://127.0.0.1:4000)
2. Click **Tunnel Config** in the top toolbar
3. Fill in the form:

| Field | Example | Notes |
|---|---|---|
| **Domain** | `yourdomain.com` | Used to build public URLs |
| **Control Port** | `7000` | Port the tunnel clients connect to on your VPS |
| **TLS Certificate** | `/etc/letsencrypt/live/yourdomain.com/fullchain.pem` | Full path on the VPS |
| **TLS Key** | `/etc/letsencrypt/live/yourdomain.com/privkey.pem` | Full path on the VPS |
| **Shared Token** | *(click Generate)* | Secret shared between server and client — keep this private |
| **Server Host** | `yourdomain.com` | Auto-filled from Domain field |
| **TLS on control connection** | **On** | Encrypts the token, visitors' logins and all page content between the VPS and your PC. Leave it on |
| **Allow self-signed certificate** | Off | Skips certificate checks on the control connection. Development only — leave off in production |

Optional settings you can add by hand to the `server` block of `tunnel-config.json`:

| Field | Default | Description |
|---|---|---|
| `maxBodyBytes` | `10485760` (10 MB) | Larger request bodies get `413 Payload Too Large` |
| `maxConcurrent` | `50` | Simultaneous public requests per tunnel; more get `503` (protects VPS memory) |
| `maxFrameBytes` | `268435456` (256 MB) | Largest single response a tunnel client may send back |
| `requestTimeout` | `30000` | Milliseconds to wait for the local site before returning `504` |
| `controlTls` | `true` | Set `false` **only** if a TLS-terminating proxy already sits in front of the control port |

![Tunnel Configuration form](docs/screenshots/04-tunnel-config.png)

4. Click **Save Config**. This writes `tunnel/tunnel-config.json` locally, and the dot on the **Tunnel Config** button turns green

5. **Copy the same file to your VPS** at the same relative path:
   ```bash
   scp tunnel/tunnel-config.json user@your-vps:~/RoWeb/tunnel/tunnel-config.json
   ```

---

### Step 2 — Deploy the Tunnel Server on Your VPS

> **Using AWS, Google Cloud or GoDaddy?** Follow the step-by-step guide in [Hosting the Tunnel on AWS, Google Cloud or GoDaddy](#hosting-the-tunnel-on-aws-google-cloud-or-godaddy) instead. It covers the server, DNS, certificate and a hardened always-on service.

Quick version — SSH into your VPS and run:

```bash
git clone https://github.com/rbughao/RoWeb.git
cd RoWeb

# Copy your tunnel config (or scp it as shown above)
# Then start the tunnel server:
node tunnel/server.js
```

You should see:

```
Tunnel server ready — domain: *.yourdomain.com
Control server  :7000  (TLS)
Public HTTPS    :443  (*.yourdomain.com)
HTTP redirect   :80  → HTTPS
```

> **Tip for production:** Use a process manager like `pm2` or a `systemd` service so the tunnel server restarts automatically.

```bash
# Example with pm2
npm install -g pm2
pm2 start tunnel/server.js --name roweb-tunnel
pm2 save
pm2 startup
```

---

### Step 3 — Create a Tunnel

**Option A — via Site Manager UI (recommended)**

1. Open [http://127.0.0.1:4000](http://127.0.0.1:4000)
2. Find the site you want to expose (only configured sites can be tunnelled)
3. Click the **🔗 Tunnel** button
4. The card shows **🔗 tunnel on**, and the preview bar shows the public URL, e.g. `https://a3f9c1b2.yourdomain.com`, or your chosen address if the site has a **Tunnel address**
5. Click **Stop Tunnel** to disconnect

**Option B — via CLI**

```bash
# Expose local port 3001 to the internet
node tunnel/client.js --port 3001

# With explicit options (overrides tunnel-config.json)
node tunnel/client.js --port 3001 --server yourdomain.com --token YOUR_SECRET

# All flags
node tunnel/client.js \
  --port 3001 \
  --server yourdomain.com \
  --control-port 7000 \
  --token YOUR_SECRET \
  --subdomain mysite \
  --insecure        # accept a self-signed cert (dev only)
```

TLS is on by default. `--no-tls` turns it off, but only use that when a TLS proxy sits in front of the control port; otherwise the token and all traffic travel unencrypted.

If the connection drops, the client reconnects automatically, waiting 3 s, then 6 s, 12 s … up to 60 s between attempts.

Output:

```
[Tunnel] Connecting to yourdomain.com:7000 for localhost:3001...
[Tunnel] Active → https://a3f9c1b2.yourdomain.com
```

Press `Ctrl+C` to stop the tunnel.

---

### Tunnel behaviour

| Scenario | Result |
|---|---|
| Client disconnects | Public URL returns `502 Bad Gateway` |
| Client reconnects (network drop, or tunnel server restarted) | It asks for the same address and gets it back, even if the server hasn't yet noticed the old connection died |
| Site has a **Tunnel address** set | Always uses that address, e.g. `https://qrcoder.yourdomain.com` |
| Request times out | Returns `504 Gateway Timeout` after 30 seconds |
| Site has Basic Auth | Auth challenge is preserved end-to-end |
| Wrong tunnel token | Server rejects with `401 Unauthorized` |
| Request body over `maxBodyBytes` | Returns `413 Payload Too Large` |
| More than `maxConcurrent` requests at once | Extra requests get `503 Service Unavailable` |
| Site's port changed, paused or deleted in the manager | Its tunnel is stopped automatically |
| Site is paused | A tunnel can't be opened for it until it's resumed |

---

## Hosting the Tunnel on AWS, Google Cloud or GoDaddy

To give your local sites public URLs, the tunnel needs three things on the internet. Each provider can supply some or all of them, and you can mix providers — for example a domain at GoDaddy pointed at a server on AWS.

| You need | What it's for | AWS | Google Cloud | GoDaddy |
|---|---|---|---|---|
| **A server** with a fixed public IP | Runs `tunnel/server.js` | EC2 + Elastic IP | Compute Engine + static IP | VPS (optional) |
| **DNS** for your domain | Sends `yourdomain.com` and `*.yourdomain.com` to the server | Route 53 | Cloud DNS | GoDaddy DNS |
| **A wildcard TLS certificate** | HTTPS for visitors, and encryption for the tunnel itself | Let's Encrypt, **renews automatically** | Let's Encrypt, **renews automatically** | Let's Encrypt, **renewed by hand** every ~60–90 days |

**Your own PC needs no changes.** You don't open ports on your router: the tunnel client on your PC dials *out* to the server.

The steps are the same everywhere:

1. Create the server and give it a fixed IP
2. Open ports **22** (SSH, just for you), **80**, **443** and **7000**
3. Point DNS records `@` and `*` at the server's IP
4. Get a certificate for `yourdomain.com` and `*.yourdomain.com`
5. [Finish the server setup](#finish-the-server-setup-all-providers) — install and start the tunnel server
6. [Connect your PC](#connect-your-pc)

Every example below uses `yourdomain.com` — replace it with your real domain. The server examples use **Ubuntu 24.04 LTS**.

---

### Option A — AWS (EC2 + Route 53)

**1. Create the server**

1. AWS Console → **EC2** → **Launch instance**
2. **Name:** `roweb-tunnel` · **Image:** Ubuntu Server 24.04 LTS · **Instance type:** `t3.micro` (or `t4g.micro`) is plenty
3. **Key pair:** create one (e.g. `roweb-key`) and download the `.pem` file — you need it to log in
4. **Network settings → Edit → security group rules:**

   | Type | Port | Source |
   |---|---|---|
   | SSH | 22 | **My IP** |
   | HTTP | 80 | Anywhere (0.0.0.0/0) |
   | HTTPS | 443 | Anywhere (0.0.0.0/0) |
   | Custom TCP | 7000 | Anywhere, or just your home IP if it never changes |

5. **Launch instance**

**2. Give it a fixed IP**

EC2 → **Elastic IPs** → **Allocate Elastic IP address** → select it → **Actions → Associate Elastic IP address** → choose `roweb-tunnel`. Use this IP everywhere below. Without it, the IP changes whenever the instance restarts.

**3. DNS in Route 53**

1. **Route 53** → **Hosted zones** → **Create hosted zone** → Domain name `yourdomain.com`, type **Public**
2. **Create record** twice, both type **A** with your Elastic IP as the value:
   - Record name: *(leave empty)* — this is `yourdomain.com`
   - Record name: `*` — this is `*.yourdomain.com`
3. If the domain is registered somewhere else (GoDaddy, Squarespace, Namecheap…), copy the 4 **NS** values shown in the zone and set them as the domain's **nameservers** at that registrar. If you bought the domain through Route 53, this is already done.

**4. Let certbot manage DNS records (for automatic renewal)**

1. **IAM** → **Roles** → **Create role** → trusted entity **AWS service**, use case **EC2**
2. Skip the managed policies, create the role (e.g. `roweb-certbot`), then add an **inline policy** (JSON). Replace `YOUR_ZONE_ID` with the hosted zone ID from Route 53:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["route53:ListHostedZones", "route53:GetChange"], "Resource": "*" },
       { "Effect": "Allow", "Action": "route53:ChangeResourceRecordSets", "Resource": "arn:aws:route53:::hostedzone/YOUR_ZONE_ID" }
     ]
   }
   ```
3. EC2 → select the instance → **Actions → Security → Modify IAM role** → choose `roweb-certbot`

**5. Log in and get the certificate**

From Windows PowerShell (the first line just restricts the key file, which SSH requires):

```powershell
icacls roweb-key.pem /inheritance:r /grant:r "$($env:USERNAME):R"
ssh -i roweb-key.pem ubuntu@YOUR_ELASTIC_IP
```

Then on the server:

```bash
sudo apt-get update
sudo apt-get install -y certbot python3-certbot-dns-route53
sudo certbot certonly --dns-route53 -d yourdomain.com -d '*.yourdomain.com'
```

Certbot creates and removes the verification records in Route 53 by itself, and renews the certificate automatically. Continue with [Finish the server setup](#finish-the-server-setup-all-providers).

---

### Option B — Google Cloud (Compute Engine + Cloud DNS)

**1. Create the server**

1. Google Cloud Console → **Compute Engine** → **VM instances** → **Create instance**
2. **Name:** `roweb-tunnel` · **Region:** e.g. `us-central1` · **Machine type:** `e2-micro` (eligible for Google's free tier in some US regions)
3. **Boot disk → Change:** Ubuntu 24.04 LTS
4. **Firewall:** tick **Allow HTTP traffic** and **Allow HTTPS traffic**
5. **Advanced options → Networking → Network tags:** add `roweb-tunnel`
6. **Create**

**2. Open the tunnel port and fix the IP**

1. **VPC network** → **Firewall** → **Create firewall rule**: name `allow-roweb-tunnel`, **Targets:** *Specified target tags* `roweb-tunnel`, **Source IPv4 ranges:** `0.0.0.0/0` (or your home IP), **Protocols and ports:** TCP `7000`
2. **VPC network** → **IP addresses** → find the VM's external IP → **⋮ → Promote to static IP address**

Prefer the command line? With the [gcloud CLI](https://cloud.google.com/sdk/docs/install):

```bash
gcloud compute instances create roweb-tunnel --zone=us-central1-a --machine-type=e2-micro --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --tags=roweb-tunnel
gcloud compute firewall-rules create allow-roweb-tunnel --allow=tcp:80,tcp:443,tcp:7000 --target-tags=roweb-tunnel
```

Then promote the IP to static in the console as above.

**3. DNS in Cloud DNS**

1. **Network services** → **Cloud DNS** → **Create zone** → type **Public**, DNS name `yourdomain.com`
2. **Add standard** record twice, both type **A** with your static IP:
   - DNS name: *(empty)* — `yourdomain.com`
   - DNS name: `*` — `*.yourdomain.com`
3. Set the domain's **nameservers** at your registrar to the 4 NS values listed in the zone.

> **Domain from Google Domains?** Google Domains moved to **Squarespace Domains** in 2023. Either point the nameservers to Cloud DNS as above, or add the two **A** records (`@` and `*`) in Squarespace's DNS settings. In that case, get the certificate the manual way described under [GoDaddy, step 3](#option-c--godaddy-domain--dns-optional-vps).

**4. Let certbot manage DNS records (for automatic renewal)**

1. **IAM & Admin** → **Service accounts** → **Create service account** `roweb-certbot` → grant the role **DNS Administrator**
2. Open it → **Keys** → **Add key → Create new key → JSON**, and download the file

**5. Log in and get the certificate**

```powershell
gcloud compute scp google-key.json roweb-tunnel:/tmp/google.json --zone=us-central1-a
gcloud compute ssh roweb-tunnel --zone=us-central1-a
```

(or use the **SSH** button next to the VM in the console). Then on the server:

```bash
sudo install -m 600 /tmp/google.json /etc/letsencrypt-google.json && rm /tmp/google.json
sudo apt-get update
sudo apt-get install -y certbot python3-certbot-dns-google
sudo certbot certonly --dns-google --dns-google-credentials /etc/letsencrypt-google.json -d yourdomain.com -d '*.yourdomain.com'
```

The certificate renews automatically. Keep the JSON key secret — it can change your DNS. Continue with [Finish the server setup](#finish-the-server-setup-all-providers).

---

### Option C — GoDaddy (domain & DNS, optional VPS)

Most people use GoDaddy for the **domain**, and run the server on AWS, Google Cloud or a GoDaddy VPS.

**1. The server**

- **On AWS or Google Cloud:** follow Option A or B, steps 1–2 only (server, firewall, fixed IP). Skip their DNS steps, because GoDaddy will handle DNS.
- **On a GoDaddy VPS:** choose an Ubuntu image, note its IP address and SSH login from the VPS dashboard, and allow inbound TCP 22, 80, 443 and 7000 in its firewall settings.

**2. DNS records in GoDaddy**

1. GoDaddy → **My Products** → **Domains** → your domain → **DNS** (Manage DNS)
2. Edit the existing **A** record with name **`@`** (it often says *Parked*) → set **Value** to your server's IP
3. **Add New Record** → Type **A**, Name **`*`**, Value your server's IP
4. If **Forwarding** is turned on for the domain, turn it off — it overrides these records

Changes usually take effect within minutes, but can take up to an hour.

**3. Get the certificate (manual DNS check)**

GoDaddy restricts its DNS API to larger accounts, so certbot generally can't add records for you. Instead, you add one TXT record by hand. On the server:

```bash
sudo apt-get update
sudo apt-get install -y certbot
sudo certbot certonly --manual --preferred-challenges dns -d yourdomain.com -d '*.yourdomain.com'
```

Certbot pauses **twice** and shows a value each time:

1. In GoDaddy DNS, **Add New Record** → Type **TXT**, Name **`_acme-challenge`**, Value = the first value certbot shows. Save.
2. Press Enter in certbot. It shows a second value for the **same** name: add a **second** TXT record `_acme-challenge` with that value. Keep both records.
3. Wait a minute or two. Check that both values are visible:
   ```bash
   dig +short TXT _acme-challenge.yourdomain.com
   ```
4. Press Enter. Once the certificate is issued, you can delete the two TXT records.

> **Renewal is manual with this method.** Let's Encrypt certificates last 90 days. Re-run the same `certbot certonly --manual …` command about every 60 days, then run `sudo /etc/letsencrypt/renewal-hooks/deploy/roweb.sh` (created in the next section). For **automatic renewal**, keep the domain registered at GoDaddy but move its DNS to Route 53 or Cloud DNS: change the domain's **Nameservers** in GoDaddy to the ones your Route 53 or Cloud DNS zone lists, then follow Option A or B from step 3.

Continue with [Finish the server setup](#finish-the-server-setup-all-providers).

---

### Finish the server setup (all providers)

Run these on the server after you have the certificate. They install Node.js, run the tunnel as an unprivileged `roweb` user, and start it automatically on boot.

**1. Install Node.js and the code**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo useradd --system --create-home --shell /usr/sbin/nologin roweb
sudo git clone https://github.com/rbughao/RoWeb.git /opt/roweb
sudo chown -R roweb:roweb /opt/roweb
```

**2. Let the `roweb` user read the certificate, now and after every renewal**

```bash
sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/roweb.sh > /dev/null <<'EOF'
#!/bin/sh
chgrp -R roweb /etc/letsencrypt/live /etc/letsencrypt/archive
chmod -R g+rX /etc/letsencrypt/live /etc/letsencrypt/archive
systemctl restart roweb-tunnel 2>/dev/null || true
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/roweb.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/roweb.sh
```

Certbot runs this script after each automatic renewal. It reloads the new certificate, because the tunnel server only reads the certificate when it starts.

**3. Create the always-on service**

```bash
sudo tee /etc/systemd/system/roweb-tunnel.service > /dev/null <<'EOF'
[Unit]
Description=RoWeb tunnel server
After=network-online.target
Wants=network-online.target

[Service]
User=roweb
WorkingDirectory=/opt/roweb
ExecStart=/usr/bin/node tunnel/server.js
Restart=always
# Lets the unprivileged user listen on ports 80 and 443
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable roweb-tunnel
```

Don't start it yet — it needs `tunnel-config.json` from your PC, which is the next step.

---

### Connect your PC

**1. Fill in Tunnel Config** in the Site Manager ([http://127.0.0.1:4000](http://127.0.0.1:4000) → **Tunnel Config**):

| Field | Value |
|---|---|
| Domain | `yourdomain.com` |
| Control Port | `7000` |
| TLS Certificate File | `/etc/letsencrypt/live/yourdomain.com/fullchain.pem` |
| TLS Key File | `/etc/letsencrypt/live/yourdomain.com/privkey.pem` |
| Shared Token | click **Generate** |
| Server Host | `yourdomain.com` |
| TLS on control connection | **On** |
| Allow self-signed certificate | **Off** (Let's Encrypt certificates are trusted) |

Click **Save Config**.

**2. Copy the config to the server and start the tunnel.** From PowerShell in the RoWeb folder:

```powershell
# AWS
scp -i roweb-key.pem tunnel\tunnel-config.json ubuntu@YOUR_SERVER_IP:/tmp/tunnel-config.json
# Google Cloud
gcloud compute scp tunnel\tunnel-config.json roweb-tunnel:/tmp/tunnel-config.json --zone=us-central1-a
# GoDaddy VPS (use the user name from your VPS dashboard)
scp tunnel\tunnel-config.json YOUR_USER@YOUR_SERVER_IP:/tmp/tunnel-config.json
```

Then on the server:

```bash
sudo install -o roweb -g roweb -m 600 /tmp/tunnel-config.json /opt/roweb/tunnel/tunnel-config.json
rm /tmp/tunnel-config.json
sudo systemctl start roweb-tunnel
sudo journalctl -u roweb-tunnel -n 20
```

The log should end with `Control server  :7000  (TLS)` and `Public HTTPS    :443`.

**3. Open a tunnel.** Back in the Site Manager, click **🔗 Tunnel** on a site. It gets a public address like `https://a3f9c1b2.yourdomain.com`.

> If you change the token or other settings later, copy `tunnel-config.json` again and run `sudo systemctl restart roweb-tunnel`.

---

### Check it works & troubleshooting

Quick checks from your PC:

```powershell
nslookup anything.yourdomain.com
```

It should return your server's IP. Then open `https://anything.yourdomain.com` in a browser. You should see a padlock and the page **"502 — No active tunnel"**. That means DNS, the certificate and the server are all working; there's just no tunnel by that name yet.

| Problem | Likely cause and fix |
|---|---|
| `nslookup` doesn't return your IP | DNS hasn't updated yet, or the `@` / `*` records or nameservers are wrong. In GoDaddy, check that forwarding is off and the old *Parked* record was replaced |
| Browser can't connect at all | Port 443 isn't open (EC2 security group / GCP firewall / VPS firewall), or the service isn't running: `sudo systemctl status roweb-tunnel` |
| Certificate warning in the browser | The certificate doesn't cover the name you used — it must include **both** `yourdomain.com` and `*.yourdomain.com` |
| **Tunnel** button: "Cannot connect… ETIMEDOUT" or "ECONNREFUSED" | Port **7000** is blocked by the cloud firewall, or the service isn't running |
| **Tunnel** button: "certificate has expired" / "unable to verify" | The certificate expired or the paths in Tunnel Config are wrong. Renew it, and check the paths match `/etc/letsencrypt/live/yourdomain.com/…` |
| **Tunnel** button: "Server rejected upgrade with HTTP 401" | The token on the server doesn't match. Copy `tunnel-config.json` again and restart the service |
| Service log: `EACCES` on port 80/443 | The `AmbientCapabilities` line is missing from the service file. Fix it, then run `sudo systemctl daemon-reload && sudo systemctl restart roweb-tunnel` |
| Service log: "Failed to read TLS cert/key" | The `roweb` user can't read the certificate. Run `sudo /etc/letsencrypt/renewal-hooks/deploy/roweb.sh` |
| Everything worked, then broke after ~90 days | The certificate expired. With Route 53 / Cloud DNS, check `sudo certbot renew --dry-run`. With GoDaddy's manual method, renew by hand (see Option C) |

**Keep it safe:** limit SSH (port 22) to your own IP, and port 7000 too if your home IP is fixed. Keep the tunnel token, the `.pem` key and any cloud credential files private, and never commit them. Ubuntu installs security updates automatically by default; leave that on.

---

## Running in Production

For long-running deployments on a server:

```bash
# Keep the server running with pm2
npm install -g pm2

pm2 start server.js --name roweb
pm2 save
pm2 startup

# View logs
pm2 logs roweb

# Restart
pm2 restart roweb
```

Or use a simple `systemd` unit file — see your distro's documentation.

---

## Security Notes

**Secrets**
- **`config.json` and `tunnel/tunnel-config.json` are gitignored.** Only `config.example.json` (no passwords) is committed
- Passwords are stored as **scrypt hashes**. Plaintext `"pass"` values are hashed on the next startup
- Missing, default or publicly known passwords (`manager123`, `secret123`, `wiki2024`, …) are **replaced with random ones** on startup and printed once
- The shared tunnel token should be at least 32 random characters — use the **Generate** button in the UI
- Usernames, passwords and tokens are compared in constant time, so nothing leaks through response timing

**Site Manager**
- Listens on `127.0.0.1` only by default, so other machines on your network can't reach it
- Site folders must live inside `sitesDir` and can't overlap, so a stolen manager login can't publish `C:\` or another site's files
- Tunnels can only be opened for configured sites, never arbitrary local ports (or the manager itself)

**File serving**
- Directory traversal (`../`, `%2e%2e`, null bytes) is blocked with `403 Forbidden`
- Hidden files and folders (`.git`, `.env`, `.htpasswd`, …) are never served; `.well-known` is allowed
- Login rules are checked against the canonical on-disk path, and **that exact file** is the one served. Windows tricks like `NOTES~1.HTM`, `file::$DATA` or different letter case can't bypass a rule
- Symlinks that point outside a site's folder are not followed

**Tunnel**
- The control connection is **TLS-encrypted by default**, and the client verifies the server's certificate unless you explicitly enable insecure mode
- Each control connection can register only one subdomain
- Limits: request body size, concurrent requests per tunnel, and maximum message size
- Connection-level headers (`Connection`, `Transfer-Encoding`, `Keep-Alive`, …) are stripped in both directions; `X-Forwarded-For` is overwritten so visitors can't spoof their IP
- HTTP → HTTPS redirects only ever point at your own domain

**Everywhere**
- All servers time out slow requests (10 s for headers, 30 s for the full request)
- Security headers on every response: `X-Content-Type-Options`, `Referrer-Policy`, plus a strict `Content-Security-Policy` on the Site Manager
- Framing (clickjacking protection): sites can only be embedded by themselves and by the Site Manager's preview (`frame-ancestors`). The manager itself can't be embedded anywhere. The preview frame is sandboxed, so a previewed site can't navigate or script the manager
- Sites use plain HTTP locally, so their logins can be sniffed on a shared network (e.g. café Wi-Fi). Set `"host": "127.0.0.1"` on sites that should stay private, and share them publicly through the tunnel, which is HTTPS end to end

### Site Manager API protection

- Passwords are **never returned** by the API, so leave a password blank when editing to keep it
- No CORS headers are sent, so other websites can't read API responses
- Every state-changing API call (`POST`/`PUT`/`DELETE`) must include the header `X-Requested-With: RoWeb`, and a cross-site `Origin` is rejected. This blocks CSRF. If you script against the API, add the header:
  ```bash
  curl -u admin:YOUR_PASSWORD -H "X-Requested-With: RoWeb" -X DELETE http://127.0.0.1:4000/api/sites/3002
  ```
- New passwords set through the API must be at least 8 characters and not a known default
- Requests whose `Host` isn't `localhost`, an IP address, or listed in `manager.allowedHosts` are rejected (DNS-rebinding protection)

---

## Passwords & First Run

There are **no default passwords**. On startup, any login whose password is missing or publicly known gets a random password, printed once in the console:

| Login | Port | Username |
|---|---|---|
| Public Home | 3000 | — (open, no login) |
| Admin Dashboard | 3001 | `admin` |
| Internal Wiki | 3002 | `team` |
| **Site Manager** | **4000** | **`admin`** |

**Set your own password (or recover a lost one):**

1. Stop the server
2. In `config.json`, find the login and replace its `"passHash": "scrypt$…"` line with `"pass": "your-new-password"`
3. Start the server again. The password is hashed automatically, and the plaintext is removed from the file

For site logins you can also just type a new password in the Site Manager's **Edit** form.

---

## License

MIT

'use strict';

const USE_COLOR = process.stdout.isTTY;

const GREEN  = USE_COLOR ? '\x1b[32m' : '';
const YELLOW = USE_COLOR ? '\x1b[33m' : '';
const DIM    = USE_COLOR ? '\x1b[2m'  : '';
const RESET  = USE_COLOR ? '\x1b[0m'  : '';

function printStartupTable(sites) {
  const rows = sites.map(site => {
    const url = `http://localhost:${site.port}`;
    const [tag, color] = site.paused ? ['[paused]', DIM] : site.auth ? ['[auth]', YELLOW] : ['[open]', GREEN];
    return { name: site.name, url, tag, color };
  });

  const nameWidth = Math.max(12, ...rows.map(r => r.name.length)) + 2;
  const urlWidth  = Math.max(24, ...rows.map(r => r.url.length))  + 2;
  const tagWidth  = 10; // "[paused]" + padding

  const innerWidth = nameWidth + urlWidth + tagWidth + 2; // 2 for separators
  const border     = '═'.repeat(innerWidth);

  console.log(`╔${border}╗`);
  console.log(`║${center('Multi-Port Web Server — Started', innerWidth)}║`);
  console.log(`╠${border}╣`);
  for (const r of rows) {
    const namePad   = r.name.padEnd(nameWidth);
    const urlPad    = r.url.padEnd(urlWidth);
    // Pad to visual width (tag.length), not including color codes
    const statusPad = `${r.color}${r.tag}${RESET}` + ' '.repeat(tagWidth - r.tag.length);
    console.log(`║  ${namePad}${urlPad}${statusPad}║`);
  }
  console.log(`╚${border}╝`);
  console.log('Press Ctrl+C to stop all servers.');
}

function center(text, width) {
  const pad   = Math.max(0, width - text.length);
  const left  = Math.floor(pad / 2);
  const right = pad - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

function logRequest(name, req, statusCode) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${name}] ${req.method} ${req.url} → ${statusCode}  (${ts})`);
}

module.exports = { printStartupTable, logRequest };

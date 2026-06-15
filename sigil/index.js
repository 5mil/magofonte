/**
 * MagoFonte — sigil module
 *
 * Serves the HTML control panel (sigil/app.html) and
 * proxies authenticated API calls to core.
 *
 * All routes under /app/* are auth-gated via ward module.
 * Static assets (login page, JS, CSS embedded in app.html) are public.
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

const Sigil = {
  name: 'sigil',

  async init(config, registry) {
    this.config   = config;
    this.registry = registry;
    return this;
  },

  get routes() {
    return [
      // Serve login page (public)
      ['GET', '/login', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(this._loginPage());
      }],

      // Serve app (auth-gated via cookie check in HTML)
      ['GET', '/', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fs.readFileSync(path.join(__dir, 'app.html'), 'utf8'));
      }],

      // Redirect bare /sigil to /sigil/
      ['GET', '', (req, res) => {
        res.writeHead(302, { Location: '/sigil/' });
        res.end();
      }]
    ];
  },

  _loginPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MagoFonte — Login</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0f; color: #e0e0e0; font-family: 'Courier New', monospace;
    display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .box { background: #111118; border: 1px solid #2a2a3a; border-radius: 8px;
    padding: 2.5rem; width: 360px; }
  h1 { color: #c8a84b; font-size: 1.4rem; margin-bottom: 0.3rem; }
  .sub { color: #555; font-size: 0.75rem; margin-bottom: 2rem; }
  label { display: block; font-size: 0.75rem; color: #888; margin-bottom: 0.3rem; }
  input { width: 100%; background: #0d0d14; border: 1px solid #2a2a3a; color: #e0e0e0;
    padding: 0.6rem 0.8rem; border-radius: 4px; font-family: inherit;
    font-size: 0.9rem; margin-bottom: 1.2rem; outline: none; }
  input:focus { border-color: #c8a84b; }
  button { width: 100%; background: #c8a84b; color: #0a0a0f; border: none;
    padding: 0.7rem; border-radius: 4px; font-family: inherit;
    font-size: 0.95rem; font-weight: bold; cursor: pointer; }
  button:hover { background: #e0c060; }
  .err { color: #e05050; font-size: 0.8rem; margin-bottom: 1rem; display: none; }
</style>
</head>
<body>
<div class="box">
  <h1>MagoFonte</h1>
  <div class="sub">home mining server</div>
  <div class="err" id="err"></div>
  <label>Username</label>
  <input type="text" id="u" autocomplete="username" autofocus />
  <label>Password</label>
  <input type="password" id="p" autocomplete="current-password" />
  <button onclick="login()">Sign in</button>
</div>
<script>
async function login() {
  const u = document.getElementById('u').value;
  const p = document.getElementById('p').value;
  const r = await fetch('/api/v1/ward/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p })
  });
  const d = await r.json();
  if (d.ok) { localStorage.setItem('mg_token', d.token); window.location = '/sigil/'; }
  else { const e = document.getElementById('err'); e.textContent = d.error || 'Login failed'; e.style.display = 'block'; }
}
document.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
</script>
</body></html>`;
  }
};

export default Sigil;

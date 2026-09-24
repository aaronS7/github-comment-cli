#!/usr/bin/env node
import { access, chmod, lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AppConfig = { clientId: string; keyPath: string; repository: string };

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(projectRoot, '.env');
const secretPath = path.join(os.homedir(), '.config', 'github-comment-cli', 'config-ui.secret');
const hosts = (process.env.GH_APP_CONFIG_HOSTS || process.env.GH_APP_CONFIG_HOST || '127.0.0.1')
  .split(',').map(value => value.trim()).filter(Boolean);
const secureCookie = process.env.GH_APP_CONFIG_SECURE_COOKIE !== 'false';
const port = Number(process.env.GH_APP_CONFIG_PORT || 4179);
const sessions = new Map<string, number>();
const failedLogins: number[] = [];
const sessionLifetimeMs = 60 * 60 * 1000;
const maxBodyBytes = 16 * 1024;

const page = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>GitHub App setup</title>
  <style>
    :root { font: 16px/1.5 system-ui, sans-serif; color-scheme: light dark; }
    body { margin: 0; background: #f3f5f8; color: #172033; }
    main { width: min(42rem, calc(100% - 2rem)); margin: 7vh auto; }
    section { background: Canvas; color: CanvasText; border: 1px solid #8792a033; border-radius: 1rem; padding: clamp(1.25rem, 5vw, 2.25rem); box-shadow: 0 1rem 3rem #16213a12; }
    h1 { margin: 0 0 .5rem; font-size: clamp(1.7rem, 4vw, 2.2rem); letter-spacing: -.03em; }
    p { color: #5d6678; }
    label { display: block; margin: 1.15rem 0 .35rem; font-weight: 650; }
    input { box-sizing: border-box; display: block; width: 100%; border: 1px solid #9aa4b4; border-radius: .45rem; padding: .72rem .8rem; font: inherit; background: Canvas; color: CanvasText; }
    input:focus { outline: 3px solid #0969da55; border-color: #0969da; }
    button { border: 0; border-radius: .5rem; padding: .75rem 1.1rem; margin-top: 1.35rem; font: inherit; font-weight: 700; color: white; background: #176b45; cursor: pointer; }
    button:hover { background: #105a39; }
    .hint { margin: .35rem 0 0; font-size: .9rem; }
    .notice { border-left: 4px solid #d29922; background: #d2992218; padding: .75rem 1rem; border-radius: .25rem; }
    .status { min-height: 1.5rem; margin-top: 1rem; font-weight: 600; }
    .error { color: #cf222e; }
    [hidden] { display: none !important; }
    @media (prefers-color-scheme: dark) {
      body { background: #111722; color: #e6edf3; }
      p, .hint { color: #aab4c2; }
      .notice { background: #d2992222; }
    }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>GitHub App setup</h1>
      <p>Save the App settings used by <code>gh-comment</code> on this machine.</p>
      <p class="notice">The private key stays on this machine. Enter its file path; this page does not upload or read the key contents. The settings are saved to this project’s ignored <code>.env</code> file.</p>
      <form id="unlock-form">
        <label for="access-code">Local access code</label>
        <input id="access-code" name="access-code" type="password" autocomplete="current-password" required>
        <p class="hint">Get the code on the host with <code>npm run app-config-ui:code</code>.</p>
        <button type="submit">Unlock settings</button>
      </form>
      <form id="settings-form" hidden>
        <label for="client-id">GitHub App Client ID</label>
        <input id="client-id" name="client-id" autocomplete="off" required>

        <label for="key-path">Private key file path</label>
        <input id="key-path" name="key-path" autocomplete="off" spellcheck="false" placeholder="/home/you/keys/github-app.pem" required>
        <p class="hint">The file must exist and have owner-only permissions (run <code>chmod 600 /path/to/key.pem</code> if needed).</p>

        <label for="repository">Default repository</label>
        <input id="repository" name="repository" autocomplete="off" placeholder="OWNER/REPO" required>
        <p class="hint">Use the repository containing the pull requests you plan to comment on.</p>

        <button type="submit">Save settings to .env</button>
      </form>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </section>
  </main>
  <script>
    const unlockForm = document.querySelector('#unlock-form');
    const settingsForm = document.querySelector('#settings-form');
    const status = document.querySelector('#status');
    const say = (message, isError = false) => {
      status.textContent = message;
      status.classList.toggle('error', isError);
    };
    async function request(path, body) {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin'
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The request failed.');
      return result;
    }
    unlockForm.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        await request('/api/login', { accessCode: document.querySelector('#access-code').value });
        const config = await request('/api/config');
        document.querySelector('#client-id').value = config.clientId || '';
        document.querySelector('#key-path').value = config.keyPath || '';
        document.querySelector('#repository').value = config.repository || '';
        unlockForm.hidden = true;
        settingsForm.hidden = false;
        say('Settings unlocked.');
      } catch (error) { say(error.message, true); }
    });
    settingsForm.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = settingsForm.querySelector('button');
      submit.disabled = true;
      try {
        await request('/api/config', {
          clientId: document.querySelector('#client-id').value,
          keyPath: document.querySelector('#key-path').value,
          repository: document.querySelector('#repository').value
        });
        say('Saved settings to .env. Run npm run mint-app-token to create a fresh installation token.');
      } catch (error) { say(error.message, true); }
      finally { submit.disabled = false; }
    });
  </script>
</body>
</html>`;

function inferRepository() {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const patterns = [
      /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/,
      /^git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/,
      /^ssh:\/\/git@[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(remote);
      if (match) return match[1];
    }
  } catch {}
  return '';
}

async function readAccessCode() {
  await mkdir(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  let code;
  try {
    code = (await readFile(secretPath, 'utf8')).trim();
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    code = randomBytes(32).toString('base64url');
    try {
      await writeFile(secretPath, `${code}\n`, { flag: 'wx', mode: 0o600 });
    } catch (writeError) {
      if (!hasCode(writeError, 'EEXIST')) throw writeError;
      code = (await readFile(secretPath, 'utf8')).trim();
    }
  }
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(code)) {
    throw new Error(`The local access code file is invalid: ${secretPath}`);
  }
  if (process.platform !== 'win32') await chmod(secretPath, 0o600);
  return code;
}

function parseManagedValue(contents: string, name: string): string {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`);
  for (const line of contents.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    const raw = match[1].trim();
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
    return raw.replace(/\s+#.*$/, '').trim();
  }
  return '';
}

async function readCurrentConfig() {
  let contents = '';
  try { contents = await readFile(envPath, 'utf8'); }
  catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  let defaultKey = '';
  const bundledKey = path.join(projectRoot, 'private-key-gh.pem');
  try { await access(bundledKey, constants.R_OK); defaultKey = bundledKey; } catch {}
  return {
    clientId: parseManagedValue(contents, 'GH_APP_CLIENT_ID'),
    keyPath: parseManagedValue(contents, 'GH_APP_PRIVATE_KEY_FILE') || defaultKey,
    repository: parseManagedValue(contents, 'GH_REPO') || inferRepository(),
  };
}

function parseAssignment(line: string): string | undefined {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return match?.[1];
}

function envLine(name: string, value: string): string {
  return `${name}="${value}"`;
}

async function saveConfig({ clientId, keyPath, repository }: AppConfig): Promise<void> {
  let existing = '';
  try { existing = await readFile(envPath, 'utf8'); }
  catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }

  try {
    const details = await lstat(envPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error('The project .env must be a regular file, not a symlink or directory.');
    }
  } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }

  const values = new Map<string, string>([
    ['GH_APP_CLIENT_ID', envLine('GH_APP_CLIENT_ID', clientId)],
    ['GH_APP_PRIVATE_KEY_FILE', envLine('GH_APP_PRIVATE_KEY_FILE', keyPath)],
    ['GH_REPO', envLine('GH_REPO', repository)],
  ]);
  const written = new Set<string>();
  const output: string[] = [];
  for (const line of (existing ? existing.split(/\r?\n/) : [])) {
    const key = parseAssignment(line);
    if (!key || !values.has(key)) {
      output.push(line);
      continue;
    }
    if (!written.has(key)) output.push(values.get(key)!);
    written.add(key);
  }
  for (const [key, value] of values) {
    if (!written.has(key)) output.push(value);
  }
  let contents = output.join('\n');
  if (contents && !contents.endsWith('\n')) contents += '\n';

  const tempPath = `${envPath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tempPath, contents, { flag: 'wx', mode: 0o600 });
    await rename(tempPath, envPath);
    if (process.platform !== 'win32') await chmod(envPath, 0o600);
  } catch (error) {
    await import('node:fs/promises').then(fs => fs.unlink(tempPath)).catch(() => {});
    throw error;
  }
}

function validateConfig(body: unknown): AppConfig {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Enter all three settings.');
  const values = body as Record<string, unknown>;
  const clientId = String(values.clientId ?? '').trim();
  const keyPathInput = String(values.keyPath ?? '').trim();
  const repository = String(values.repository ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(clientId)) {
    throw new Error('Enter a valid GitHub App Client ID.');
  }
  if (!/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.test(repository)) {
    throw new Error('Repository must be in OWNER/REPO form.');
  }
  if (!keyPathInput || /[\x00-\x1f\x7f"`$!\\]/.test(keyPathInput)) {
    throw new Error('Enter a file path without quotes, backticks, dollar signs, exclamation marks, or line breaks.');
  }
  const expandedKeyPath = keyPathInput === '~'
    ? os.homedir()
    : keyPathInput.startsWith('~/')
      ? path.join(os.homedir(), keyPathInput.slice(2))
      : keyPathInput;
  const keyPath = path.resolve(projectRoot, expandedKeyPath);
  return { clientId, keyPath, repository };
}

function sendJson(response: ServerResponse, status: number, data: unknown, extraHeaders: Record<string, string> = {}): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(JSON.stringify(data));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> | null; }
  catch { throw new Error('Request must contain valid JSON.'); }
}

function sessionFrom(request: IncomingMessage): string | undefined {
  const cookies = (request.headers.cookie || '').split(';');
  const cookie = cookies.map(item => item.trim()).find(item => item.startsWith('ghapp_session='));
  const id = cookie?.slice('ghapp_session='.length);
  const expiresAt = id ? sessions.get(id) : undefined;
  if (!expiresAt || expiresAt < Date.now()) {
    if (id) sessions.delete(id);
    return undefined;
  }
  return id;
}

function fetchSiteAllowed(request: IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

function rateLimited() {
  const now = Date.now();
  while (failedLogins.length && failedLogins[0] < now - 60_000) failedLogins.shift();
  return failedLogins.length >= 8;
}

async function startServer() {
  const accessCode = await readAccessCode();
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");

    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(page);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/login') {
        if (!fetchSiteAllowed(request)) return sendJson(response, 403, { error: 'Cross-site request rejected.' });
        if (rateLimited()) return sendJson(response, 429, { error: 'Too many attempts. Try again in one minute.' });
        const body = await readJson(request);
        const candidate = Buffer.from(String(body?.accessCode ?? ''));
        const expected = Buffer.from(accessCode);
        const valid = candidate.length === expected.length && timingSafeEqual(candidate, expected);
        if (!valid) {
          failedLogins.push(Date.now());
          return sendJson(response, 401, { error: 'The access code was not accepted.' });
        }
        const id = randomBytes(32).toString('base64url');
        sessions.set(id, Date.now() + sessionLifetimeMs);
        const secureFlag = secureCookie ? '; Secure' : '';
        return sendJson(response, 200, { ok: true }, {
          'Set-Cookie': `ghapp_session=${id}; Path=/; HttpOnly${secureFlag}; SameSite=Strict; Max-Age=3600`,
        });
      }

      if (url.pathname.startsWith('/api/')) {
        if (!sessionFrom(request)) return sendJson(response, 401, { error: 'Unlock the settings page first.' });
        if (request.method === 'GET' && url.pathname === '/api/config') {
          return sendJson(response, 200, await readCurrentConfig());
        }
        if (request.method === 'POST' && url.pathname === '/api/config') {
          if (!fetchSiteAllowed(request)) return sendJson(response, 403, { error: 'Cross-site request rejected.' });
          const config = validateConfig(await readJson(request));
          const keyStats = await stat(config.keyPath).catch(() => undefined);
          if (!keyStats?.isFile()) return sendJson(response, 400, { error: 'That private key path does not point to a readable file.' });
          try { await access(config.keyPath, constants.R_OK); }
          catch { return sendJson(response, 400, { error: 'The private key file is not readable by this user.' }); }
          if (process.platform !== 'win32' && (keyStats.mode & 0o077) !== 0) {
            return sendJson(response, 400, { error: 'The private key permissions are too open. On the host, run chmod 600 on the .pem file.' });
          }
          await saveConfig(config);
          return sendJson(response, 200, { ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/logout') {
          const id = sessionFrom(request);
          if (id) sessions.delete(id);
          const secureFlag = secureCookie ? '; Secure' : '';
          return sendJson(response, 200, { ok: true }, {
            'Set-Cookie': `ghapp_session=; Path=/; HttpOnly${secureFlag}; SameSite=Strict; Max-Age=0`,
          });
        }
      }
      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      sendJson(response, 400, { error: errorMessage(error) || 'Could not process the request.' });
    }
  };

  const servers = [];
  try {
    for (const listenHost of hosts) {
      const server = createServer(handleRequest);
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => reject(error);
        server.once('error', fail);
        server.listen(port, listenHost, () => {
          server.removeListener('error', fail);
          server.on('error', error => {
            process.stderr.write(`GitHub App setup server: ${errorMessage(error)}\n`);
            process.exitCode = 1;
          });
          resolve();
        });
      });
    }
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }
  process.stdout.write(`GitHub App setup page listening on ${hosts.map(listenHost => `http://${listenHost}:${port}`).join(', ')}\n`);
}

if (process.argv.includes('--show-code')) {
  readAccessCode().then(code => process.stdout.write(`${code}\n`)).catch(error => {
    process.stderr.write(`GitHub App setup code: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
} else {
  startServer().catch(error => {
    process.stderr.write(`GitHub App setup server: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

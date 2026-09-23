#!/usr/bin/env node
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppAuth } from '@octokit/auth-app';
import { saveTokenToEnv } from './src/app-env.js';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const cliEntrypoint = path.join(projectRoot, 'bin', 'gh-comment.js');
const envFile = process.env.GH_APP_ENV_FILE?.trim() || '.env';
const envPath = path.resolve(process.cwd(), envFile);
const appSettingNames = ['GH_APP_CLIENT_ID', 'GH_APP_PRIVATE_KEY_FILE', 'GH_REPO'];

function valueFromEnvLine(line, name) {
  const match = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(line);
  if (!match) return undefined;
  const value = match[1].trim();
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, '').trim();
}

try {
  const contents = await readFile(envPath, 'utf8');
  for (const name of appSettingNames) {
    if (process.env[name] !== undefined) continue;
    const value = contents.split(/\r?\n/).map(line => valueFromEnvLine(line, name)).find(item => item !== undefined);
    if (value !== undefined) process.env[name] = value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function optionValue(args, name) {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) return args[index + 1];
    if (args[index]?.startsWith(prefix)) return args[index].slice(prefix.length);
  }
  return undefined;
}

function repoFromPullRequest(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname !== 'github.com') return undefined;
    const match = /^\/([^/]+)\/([^/]+)\/pull\/[1-9]\d*(?:\/|$)/.exec(url.pathname);
    return match ? `${match[1]}/${match[2]}` : undefined;
  } catch {
    return undefined;
  }
}

function repoFromRemote() {
  let remote;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }

  const patterns = [
    /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/,
    /^git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/,
    /^ssh:\/\/git@[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(remote);
    if (match) return match[1];
  }
  return undefined;
}

function inferredRepo(args) {
  return optionValue(args, '--repo')
    || repoFromPullRequest(optionValue(args, '--pr'))
    || process.env.GH_REPO?.trim()
    || repoFromRemote();
}

function validateRepo(value) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value.trim());
  if (!match) throw new Error('Repository must be in OWNER/REPO form, for example aaronS7/github-comment-cli.');
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

async function promptValue(rl, label, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue || '';
}

async function privateKeyDefault() {
  if (process.env.GH_APP_PRIVATE_KEY_FILE?.trim()) return process.env.GH_APP_PRIVATE_KEY_FILE.trim();
  const localKey = path.join(projectRoot, 'private-key-gh.pem');
  try {
    await access(localKey, constants.R_OK);
    return localKey;
  } catch {
    return '';
  }
}

async function collectInputs(args) {
  if (!process.stdin.isTTY) {
    throw new Error('Run this command in an interactive terminal so it can prompt for the App credentials.');
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const clientId = await promptValue(rl, 'GitHub App Client ID', process.env.GH_APP_CLIENT_ID?.trim());
    if (!clientId) throw new Error('A GitHub App Client ID is required.');

    const keyPathInput = await promptValue(rl, 'Private key (.pem) file location', await privateKeyDefault());
    if (!keyPathInput) throw new Error('A private key file location is required.');

    const repoDefault = inferredRepo(args);
    const repoInput = await promptValue(rl, 'Target repository (OWNER/REPO)', repoDefault);
    if (!repoInput) throw new Error('A target repository is required.');

    return {
      clientId,
      keyPath: path.resolve(process.cwd(), keyPathInput),
      repository: validateRepo(repoInput),
    };
  } finally {
    rl.close();
  }
}

async function mintInstallationToken({ clientId, keyPath, repository }) {
  const keyStats = await stat(keyPath).catch(() => undefined);
  if (!keyStats?.isFile()) throw new Error(`Could not read a private key file at: ${keyPath}`);
  if (process.platform !== 'win32' && (keyStats.mode & 0o077) !== 0) {
    throw new Error('Private key permissions are too open; set the file permissions to 600.');
  }

  const privateKey = await readFile(keyPath, 'utf8');
  const auth = createAppAuth({ appId: clientId, privateKey });
  const appJwt = await auth({ type: 'app' });
  const url = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/installation`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${appJwt.token}`,
    },
  });

  if (!response.ok) {
    const message = response.status === 404
      ? 'App installation not found for this repository. Install the App on the target repository and check the repository name.'
      : `GitHub could not find the App installation (HTTP ${response.status}). Check the Client ID, private key, and App installation.`;
    throw new Error(message);
  }

  const installation = await response.json();
  const tokenAuth = await auth({
    type: 'installation',
    installationId: installation.id,
    repositoryNames: [repository.repo],
    permissions: { pull_requests: 'write' },
  });
  return tokenAuth.token;
}

function runGhComment(args, token, repository) {
  const cliArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--repo') {
      index += 1;
      continue;
    }
    if (args[index]?.startsWith('--repo=')) continue;
    cliArgs.push(args[index]);
  }
  cliArgs.push('--repo', repository.fullName);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntrypoint, ...cliArgs], {
      cwd: process.cwd(),
      env: { ...process.env, GH_TOKEN: token },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && args[0] !== 'post') {
    throw new Error('Usage: npm run gh-comment:app -- post <report.md> --pr <number|URL> [gh-comment options]');
  }

  const { clientId, keyPath, repository } = await collectInputs(args);
  const token = await mintInstallationToken({ clientId, keyPath, repository });
  const savedEnvPath = await saveTokenToEnv(token, envPath);
  process.stderr.write(`Saved GH_TOKEN to ${savedEnvPath}; this installation token expires after one hour.\n`);
  if (args.length) process.exitCode = await runGhComment(args, token, repository);
}

main().catch(error => {
  process.stderr.write(`gh-comment App auth: ${error.message}\n`);
  process.exitCode = 1;
});

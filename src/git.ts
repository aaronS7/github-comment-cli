import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

export class RepositoryError extends Error {
  code: string;
  constructor(message: string, code = 'REFERENCE_ERROR', options?: ErrorOptions) {
    super(message, options);
    this.name = 'RepositoryError';
    this.code = code;
  }
}

/** Parse a local Markdown destination, without interpreting remote URLs or headings. */
export function parseLocalReference(target: unknown) {
  if (typeof target !== 'string' || target.length === 0) return null;
  if (target.startsWith('#') || target.startsWith('//')) return null;
  if (/^(?:https?|ftp|ftps|mailto|tel|sms|ssh|git|data|urn|irc|ircs|news|about|blob|javascript):/i.test(target)) return null;
  const windowsAbsolutePath = /^[a-z]:[\\/]/i.test(target);
  if (/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith('file:') && !windowsAbsolutePath && !/^[^/]+:\d+(?:-\d+)?$/.test(target)) {
    return null;
  }

  let local = target;
  let startLine;
  let endLine;
  const fragment = /#L(\d+)(?:-L?(\d+))?$/.exec(local);
  const colon = /:(\d+)(?:-(\d+))?$/.exec(local);
  const location = fragment ?? colon;
  if (location) {
    startLine = Number(location[1]);
    endLine = Number(location[2] ?? location[1]);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new RepositoryError(`Invalid line range in "${target}". Use positive line numbers in ascending order.`, 'INVALID_LINES');
    }
    local = local.slice(0, location.index);
  }

  if (/[?#]/.test(local)) return null;
  if (local.length === 0 || /[\x00-\x1f\x7f]/.test(local)) {
    throw new RepositoryError(`Invalid local file reference: "${target}".`, 'INVALID_PATH');
  }
  try {
    local = local.startsWith('file:') ? fileURLToPath(local) : decodeURIComponent(local);
  } catch (cause) {
    throw new RepositoryError(`Invalid encoded file path in "${target}".`, 'INVALID_PATH', { cause });
  }
  if (/[\x00-\x1f\x7f]/.test(local)) {
    throw new RepositoryError(`Invalid local file reference: "${target}".`, 'INVALID_PATH');
  }
  return { path: local, startLine, endLine };
}

function repositoryName(value: string | {owner: string; repo: string}) {
  const fullName = typeof value === 'string' ? value : value && `${value.owner}/${value.repo}`;
  const match = /^([A-Za-z\d_.-]+)\/([A-Za-z\d_.-]+)$/.exec(fullName ?? '');
  if (!match || match.slice(1).some(part => part === '.' || part === '..')) {
    throw new RepositoryError('Expected a GitHub repository in OWNER/REPO form.', 'INVALID_REPOSITORY');
  }
  return { owner: match[1], repo: match[2], fullName, webUrl: `https://github.com/${fullName}` };
}

/** Only github.com remotes are supported in this first version. */
export function parseGitHubRemote(remote: string) {
  let pathname;
  const scp = /^(?:[^@/\s]+@)?github\.com:([^\s]+)$/i.exec(remote);
  if (scp) {
    pathname = scp[1];
  } else {
    let url;
    try { url = new URL(remote); } catch { /* Report the same useful error below. */ }
    if (!url || url.hostname.toLowerCase() !== 'github.com' || !['https:', 'ssh:'].includes(url.protocol) || url.search || url.hash) {
      throw new RepositoryError('The Git remote is not a supported github.com HTTPS or SSH URL. Pass --repo OWNER/REPO.', 'UNSUPPORTED_REMOTE');
    }
    pathname = url.pathname.replace(/^\//, '');
  }
  return repositoryName(pathname.replace(/\/$/, '').replace(/\.git$/, ''));
}

function runGit(cwd: string, args: string[], options: {buffer: true}): Promise<Buffer>;
function runGit(cwd: string, args: string[], options?: {buffer?: false}): Promise<string>;
async function runGit(cwd: string, args: string[], { buffer = false }: {buffer?: boolean} = {}): Promise<string | Buffer> {
  const { stdout } = await execFileAsync('git', ['--literal-pathspecs', '-C', cwd, ...args], {
    encoding: buffer ? 'buffer' : 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return buffer ? stdout : (typeof stdout === 'string' ? stdout : stdout.toString('utf8')).trimEnd();
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeLineEndings(bytes: Buffer) {
  let pairs = 0;
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) pairs += 1;
  }
  if (pairs === 0) return bytes;
  const normalized = Buffer.allocUnsafe(bytes.length - pairs);
  let cursor = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) continue;
    normalized[cursor++] = bytes[index];
  }
  return normalized;
}

export class Repository {
  root: string;
  constructor(root: string) {
    this.root = root;
  }

  static async discover(cwd = process.cwd()) {
    try {
      const root = await runGit(cwd, ['rev-parse', '--show-toplevel']);
      return new Repository(await realpath(root));
    } catch (cause) {
      throw new RepositoryError(`Cannot find a Git working tree at "${cwd}". Run inside a checkout or pass --cwd.`, 'NOT_A_REPOSITORY', { cause });
    }
  }

  async head() {
    return this.resolveCommit('HEAD');
  }

  async resolveCommit(ref = 'HEAD') {
    try {
      if (typeof ref !== 'string' || ref.length === 0) throw new Error('Missing commit reference');
      const sha = await runGit(this.root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
      if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(sha)) throw new Error('Invalid commit hash');
      return sha;
    } catch (cause) {
      throw new RepositoryError(`Commit "${ref}" is not available in this checkout. Check out or fetch the intended PR commit first.`, 'MISSING_COMMIT', { cause });
    }
  }

  async remote() {
    let names;
    try {
      names = (await runGit(this.root, ['remote'])).split('\n').filter(Boolean);
    } catch (cause) {
      throw new RepositoryError('Cannot read Git remotes. Pass --repo OWNER/REPO.', 'MISSING_REMOTE', { cause });
    }
    const name = names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : null;
    if (!name) {
      throw new RepositoryError('Cannot choose a GitHub remote. Add an origin remote or pass --repo OWNER/REPO.', 'MISSING_REMOTE');
    }
    return parseGitHubRemote(await runGit(this.root, ['remote', 'get-url', name]));
  }

  /** Resolve against the selected commit and ensure local line numbers still describe it. */
  async resolveReference(target: string, { sha, repo }: {sha?: string; repo?: string | {owner: string; repo: string}} = {}) {
    const reference = parseLocalReference(target);
    if (!reference) throw new RepositoryError(`Not a local file reference: "${target}".`, 'INVALID_PATH');
    const inputAbsolute = path.resolve(this.root, reference.path);
    let absolute = inputAbsolute;
    if (!isWithin(this.root, absolute) && path.isAbsolute(reference.path)) {
      // macOS /var and Windows short names can spell an existing checkout
      // differently. Accept the alias only when it resolves inside the root.
      try {
        const canonical = await realpath(absolute);
        if (isWithin(this.root, canonical)) absolute = canonical;
      } catch { /* Keep the lexical path so the normal outside/missing checks apply. */ }
    }
    if (!isWithin(this.root, absolute)) {
      throw new RepositoryError(`Reference "${target}" is outside the repository. Use a path inside ${this.root}.`, 'OUTSIDE_REPOSITORY');
    }
    const relative = path.relative(this.root, absolute).split(path.sep).join('/');
    if (!relative) throw new RepositoryError(`Reference "${target}" must name a file.`, 'INVALID_PATH');

    let fileStat;
    try {
      fileStat = await lstat(inputAbsolute);
      if (!isWithin(this.root, await realpath(inputAbsolute))) {
        throw new RepositoryError(`Reference "${target}" resolves outside the repository.`, 'OUTSIDE_REPOSITORY');
      }
    } catch (cause) {
      if (cause instanceof RepositoryError) throw cause;
      throw new RepositoryError(`Local file "${relative}" does not exist or cannot be read. Paths are relative to the repository root.`, 'MISSING_FILE', { cause });
    }
    if (!fileStat.isFile()) {
      throw new RepositoryError(`Reference "${relative}" must name a regular file; directories and symbolic links cannot be linked by line.`, 'INVALID_FILE');
    }

    const commit = await this.resolveCommit(sha ?? 'HEAD');
    let snapshot;
    try {
      const entry = await runGit(this.root, ['ls-tree', '-z', commit, '--', relative]);
      if (!/^(100644|100755) blob [a-f\d]+\t/.test(entry)) throw new Error('No regular tracked file');
      const object = entry.match(/^[^ ]+ blob ([a-f\d]+)\t/)![1];
      snapshot = await runGit(this.root, ['cat-file', 'blob', object], { buffer: true });
    } catch (cause) {
      throw new RepositoryError(`File "${relative}" is not a regular tracked file at ${commit.slice(0, 12)}. Commit it and use a matching checkout.`, 'UNTRACKED_FILE', { cause });
    }
    const working = await readFile(absolute);
    if (!snapshot.equals(working) && !normalizeLineEndings(snapshot).equals(normalizeLineEndings(working))) {
      throw new RepositoryError(`Local file "${relative}" differs from ${commit.slice(0, 12)}. Commit your changes or check out the intended commit so its line numbers match.`, 'DIRTY_REFERENCE');
    }
    if (reference.startLine !== undefined) {
      if (snapshot.includes(0)) throw new RepositoryError(`Cannot link to a line in binary file "${relative}".`, 'BINARY_FILE');
      let lines = snapshot.length > 0 && snapshot.at(-1) !== 10 ? 1 : 0;
      for (const byte of snapshot) if (byte === 10) lines += 1;
      if (reference.endLine! > lines) {
        throw new RepositoryError(`Line ${reference.endLine} is outside "${relative}", which has ${lines} line${lines === 1 ? '' : 's'} at ${commit.slice(0, 12)}.`, 'LINE_OUT_OF_BOUNDS');
      }
    }
    const remote = repo === undefined ? await this.remote() : repositoryName(repo);
    const encodedPath = relative.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
    const plain = reference.startLine !== undefined && /\.(md|markdown)$/i.test(relative) ? '?plain=1' : '';
    const anchor = reference.startLine === undefined ? '' : `#L${reference.startLine}${reference.endLine === reference.startLine ? '' : `-L${reference.endLine}`}`;
    return {
      url: `${remote.webUrl}/blob/${commit}/${encodedPath}${plain}${anchor}`,
      path: relative,
      startLine: reference.startLine,
      endLine: reference.endLine,
    };
  }
}

import { execFile } from 'node:child_process';
import { ReadStream } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_API = 'https://api.github.com';
const DEFAULT_SERVER = 'https://github.com';
// The native endpoint used by GitHub CLI's attachments uploader, not the REST
// release-assets endpoint. Never derive this host from user input or a response.
const ATTACHMENT_UPLOAD_URL = 'https://uploads.github.com/user-attachments/assets';

async function execute(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    ...options, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

/** Parse owner/repo, an HTTPS GitHub remote, or an SSH GitHub remote. */
export function parseRepo(value, { serverUrl = DEFAULT_SERVER } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Repository must be owner/repo.');
  const input = value.trim();
  const hostname = new URL(serverUrl).hostname;
  let repo = input;
  const ssh = /^git@([^:]+):(.+)$/.exec(input);
  if (ssh) {
    if (ssh[1].toLowerCase() !== hostname.toLowerCase()) throw new Error('Git remote is not on the configured GitHub host.');
    repo = ssh[2];
  } else if (/^[a-z]+:\/\//i.test(input)) {
    const url = new URL(input);
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== hostname.toLowerCase()) {
      throw new Error('Repository URL is not on the configured GitHub host.');
    }
    if (url.password || (url.protocol === 'https:' && url.username) || url.search || url.hash) {
      throw new Error('Repository URL must not contain credentials, a query, or a fragment.');
    }
    repo = url.pathname.replace(/^\//, '');
  }
  repo = repo.replace(/\/$/, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repo) || ['.', '..'].includes(repo.split('/')[1])) {
    throw new Error('Repository must be owner/repo or a GitHub repository URL.');
  }
  return repo;
}

/** Return { number, repo? } for a number or a complete pull request URL. */
export function parsePullRequest(value, { serverUrl = DEFAULT_SERVER } = {}) {
  if (/^[1-9]\d*$/.test(String(value))) return { number: positiveInteger(value, 'Pull request number') };
  let url;
  try { url = new URL(value); } catch { throw new Error('Pull request must be a positive number or a GitHub pull request URL.'); }
  const server = new URL(serverUrl);
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/.exec(url.pathname);
  if (url.origin !== server.origin || url.username || url.password || !match) {
    throw new Error('Pull request URL must identify a pull request on the configured GitHub host.');
  }
  return { repo: parseRepo(`${match[1]}/${match[2]}`, { serverUrl }), number: positiveInteger(match[3], 'Pull request number') };
}

export async function resolveToken({ env = process.env, run = execute, serverUrl = env.GITHUB_SERVER_URL || DEFAULT_SERVER } = {}) {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (env[name]?.trim()) return env[name].trim();
  }
  try {
    return (await run('gh', ['auth', 'token', '--hostname', new URL(serverUrl).hostname], { env })).trim() || undefined;
  } catch {
    return undefined;
  }
}

export class GitHubError extends Error {
  constructor(message, { status, method, path } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

export class GitHub {
  #token;
  #fetch;
  #attachmentRepositories = new Map();

  constructor({ token, apiUrl = DEFAULT_API, fetch = globalThis.fetch, timeoutMs = 30_000 } = {}) {
    const api = new URL(apiUrl);
    if ((api.protocol !== 'https:' && !(api.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname))) || api.username || api.password || api.search || api.hash) {
      throw new Error('GitHub API URL must use HTTPS (HTTP is allowed for local testing).');
    }
    this.apiUrl = api.href.replace(/\/$/, '');
    this.#token = token;
    this.#fetch = fetch;
    this.timeoutMs = timeoutMs;
  }

  get authenticated() { return Boolean(this.#token); }

  #redact(value) {
    return this.#token ? String(value).replaceAll(this.#token, '[redacted]') : String(value);
  }

  #url(path) {
    const url = new URL(path.startsWith('/') ? `${this.apiUrl}${path}` : path);
    const api = new URL(this.apiUrl);
    const graphqlPath = api.pathname.replace(/\/api\/v3\/?$/, '/api/graphql').replace(/\/$/, '') || '/graphql';
    if (url.origin !== api.origin || (!url.pathname.startsWith(`${api.pathname.replace(/\/$/, '')}/`) && url.pathname !== graphqlPath) || url.username || url.password) {
      throw new Error('Refusing to send GitHub credentials to an unexpected API URL.');
    }
    return url;
  }

  async #request(method, path, body) {
    const url = this.#url(path);
    if (!['GET', 'HEAD'].includes(method) && !this.#token) {
      throw new Error('GitHub authentication is required to publish. Set GH_TOKEN or GITHUB_TOKEN, or run gh auth login.');
    }
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'github-comment-cli',
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    let raw;
    const uncertainty = ['GET', 'HEAD'].includes(method) ? '' : ' The request may have reached GitHub; check the PR before retrying.';
    try {
      response = await this.#fetch(url.href, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      });
      raw = await response.text();
    } catch (error) {
      throw new GitHubError(`GitHub ${method} request failed: ${this.#redact(error.message)}.${uncertainty}`, { method, path: url.pathname });
    }
    let data;
    try { data = raw ? JSON.parse(raw) : undefined; } catch {
      throw new GitHubError(`GitHub returned an invalid JSON response (HTTP ${response.status}).${uncertainty}`, { status: response.status, method, path: url.pathname });
    }
    if (!response.ok) {
      const detail = typeof data?.message === 'string' ? this.#redact(data.message) : 'Request failed';
      const hint = response.status === 401 ? ' Check GH_TOKEN/GITHUB_TOKEN or gh auth login.'
        : response.status === 403 ? ' Check token permissions (pull-requests: write for publishing) and rate limits.'
          : response.status === 404 ? ' Check the repository, PR number, and token access.'
            : response.status === 422 ? ' Check the comment body and ensure inline lines are present in the PR diff.' : '';
      throw new GitHubError(`GitHub ${method} ${url.pathname}: HTTP ${response.status}: ${detail}.${hint}${response.status >= 500 ? uncertainty : ''}`, { status: response.status, method, path: url.pathname });
    }
    return { data, headers: response.headers };
  }

  async request(method, path, body) {
    return (await this.#request(method.toUpperCase(), path, body)).data;
  }

  async getViewer() {
    try {
      const viewer = await this.request('GET', '/user');
      if (!Number.isSafeInteger(viewer?.id) || viewer.id < 1 || !viewer.login) throw new Error('GitHub did not return a valid authenticated user.');
      return viewer;
    } catch (error) {
      // Installation tokens cannot use all REST user endpoints. Query the actual
      // authenticated identity; GITHUB_ACTOR identifies the workflow triggerer.
      if (!(error instanceof GitHubError) || error.status !== 403) throw error;
      const api = new URL(this.apiUrl);
      api.pathname = api.pathname.replace(/\/api\/v3\/?$/, '/api/graphql').replace(/\/$/, '') || '/graphql';
      const result = await this.request('POST', api.href, { query: 'query { viewer { login databaseId } }' });
      const viewer = result?.data?.viewer;
      if (result?.errors?.length || !Number.isSafeInteger(viewer?.databaseId) || viewer.databaseId < 1 || !viewer.login) {
        throw new Error('Could not verify the authenticated GitHub identity. Duplicate detection and keyed updates require a supported token.');
      }
      return { id: viewer.databaseId, login: viewer.login };
    }
  }

  async preflightAttachmentUpload(repo) {
    if (this.apiUrl !== DEFAULT_API) {
      throw new Error('Native attachment uploads currently support github.com only.');
    }
    if (!this.#token) {
      throw new Error('Attachment uploads require authentication with a GitHub OAuth token or personal access token.');
    }
    if (!/^(?:gho_|ghp_|github_pat_)[A-Za-z0-9_]+$/.test(this.#token)) {
      throw new Error('Attachment uploads require an OAuth token, classic personal access token, or fine-grained personal access token. GitHub App tokens and the Actions GITHUB_TOKEN cannot upload attachments.');
    }
    const name = parseRepo(repo);
    const key = name.toLowerCase();
    if (!this.#attachmentRepositories.has(key)) {
      const pending = (async () => {
        let repository;
        try { repository = await this.request('GET', `/repos/${name}`); }
        catch (error) {
          const status = error instanceof GitHubError ? error.status : undefined;
          throw new GitHubError(`Could not authorize attachment uploads${status ? ` (HTTP ${status})` : ''}. Check the repository and the token's access.`, { status, method: 'GET', path: `/repos/${name}` });
        }
        if (!Number.isSafeInteger(repository?.id) || repository.id <= 0) {
          throw new Error('GitHub did not return a valid repository ID for attachment uploads.');
        }
        if (repository.permissions?.push !== true) {
          throw new Error('Attaching files requires write access to the repository; GitHub did not confirm that permission for this token.');
        }
        return Object.freeze({ ...repository, permissions: Object.freeze({ ...repository.permissions }) });
      })();
      this.#attachmentRepositories.set(key, pending);
      // Failed authorization is not a reusable upload capability.
      pending.catch(() => { if (this.#attachmentRepositories.get(key) === pending) this.#attachmentRepositories.delete(key); });
    }
    return this.#attachmentRepositories.get(key);
  }

  async uploadAttachment(repo, asset) {
    if (!asset || typeof asset.name !== 'string' || !asset.name.trim() || /[/\\\x00-\x1f\x7f]/.test(asset.name)
      || ['.', '..'].includes(asset.name) || typeof asset.contentType !== 'string'
      || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(asset.contentType)
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || typeof asset.openBody !== 'function') {
      throw new Error('Attachment upload requires a filename, content type, positive byte size, and body opener.');
    }
    const repository = await this.preflightAttachmentUpload(repo);
    const url = new URL(ATTACHMENT_UPLOAD_URL);
    url.search = new URLSearchParams({ name: asset.name, content_type: asset.contentType, repository_id: String(repository.id) });
    let body;
    try { body = await asset.openBody(); }
    catch { throw new Error('Could not open the attachment body for upload.'); }
    try {
      if (!Buffer.isBuffer(body) && !(body instanceof ReadStream)) {
        throw new Error('Attachment body must be a Buffer or a file ReadStream.');
      }
      if (Buffer.isBuffer(body) && body.byteLength !== asset.size) {
        throw new Error('Attachment body size changed before upload.');
      }
      let response;
      let raw;
      const uncertainty = ' The attachment may have uploaded; inspect the result before retrying. No upload was retried.';
      try {
        response = await this.#fetch(url.href, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.#token}`,
            'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.size),
            'User-Agent': 'github-comment-cli',
          },
          body, ...(body instanceof ReadStream ? { duplex: 'half' } : {}),
          redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        });
        raw = await response.text();
      } catch {
        // Upload errors can contain signed storage URLs or headers. Do not
        // include raw transport errors, response bodies, or query strings.
        throw new GitHubError(`GitHub attachment upload did not return a complete response.${uncertainty}`, { method: 'POST', path: '/user-attachments/assets' });
      }
      const redirected = Boolean(response.redirected) || response.status >= 300 && response.status < 400;
      if (!response.ok || redirected) {
        const hint = response.status === 401 ? ' Check the user token.'
          : [403, 404].includes(response.status) ? ' Attaching files requires repository write access and a supported user token.'
            : response.status === 413 ? ' The attachment is too large.'
              : response.status === 422 ? ' GitHub rejected the attachment; check the file type and size.'
                : response.status === 429 ? ' GitHub rate limited the upload.'
                  : redirected ? ' Authenticated upload redirects are refused.' : '';
        throw new GitHubError(`GitHub attachment upload failed (HTTP ${response.status}).${hint}${response.status >= 500 || redirected ? uncertainty : ''}`, { status: response.status, method: 'POST', path: '/user-attachments/assets' });
      }
      let assetUrl;
      try {
        const value = JSON.parse(raw)?.url;
        if (typeof value !== 'string') throw new Error();
        assetUrl = new URL(value);
        if (assetUrl.origin !== DEFAULT_SERVER || assetUrl.username || assetUrl.password || assetUrl.search || assetUrl.hash
          || !/^\/user-attachments\/assets\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(assetUrl.pathname)) throw new Error();
      } catch {
        throw new GitHubError(`GitHub returned an invalid attachment URL.${uncertainty}`, { status: response.status, method: 'POST', path: '/user-attachments/assets' });
      }
      return assetUrl.href;
    } finally {
      if (body instanceof ReadStream) {
        const closed = finished(body, { cleanup: true }).catch(() => {});
        body.destroy();
        await closed;
      }
    }
  }

  async paginate(path) {
    const first = this.#url(path);
    first.searchParams.set('per_page', '100');
    let next = first.href;
    const items = [];
    const visited = new Set();
    while (next) {
      if (visited.has(next)) throw new Error('GitHub pagination returned a repeated page.');
      visited.add(next);
      const { data, headers } = await this.#request('GET', next);
      if (!Array.isArray(data)) throw new Error('GitHub returned an unexpected list response.');
      items.push(...data);
      next = headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return items;
  }

  getPull(repo, number) { return this.request('GET', `/repos/${repo}/pulls/${positiveInteger(number, 'Pull request number')}`); }
  async findPull(repo, head) {
    const query = new URLSearchParams({ state: 'open', head });
    const pulls = await this.paginate(`/repos/${repo}/pulls?${query}`);
    if (pulls.length === 0) throw new Error(`No open pull request found for branch ${head}. Pass --pr explicitly.`);
    if (pulls.length > 1) throw new Error(`Multiple open pull requests found for branch ${head}. Pass --pr explicitly.`);
    return pulls[0];
  }
  createComment(repo, number, body) { return this.request('POST', `/repos/${repo}/issues/${positiveInteger(number, 'Pull request number')}/comments`, { body }); }
  listComments(repo, number) { return this.paginate(`/repos/${repo}/issues/${positiveInteger(number, 'Pull request number')}/comments`); }
  updateComment(repo, id, body) { return this.request('PATCH', `/repos/${repo}/issues/comments/${positiveInteger(id, 'Comment ID')}`, { body }); }
  createReviewComment(repo, number, entry, body, sha) {
    return this.request('POST', `/repos/${repo}/pulls/${positiveInteger(number, 'Pull request number')}/comments`, {
      body, commit_id: sha, path: entry.path, line: entry.line, side: entry.side,
      ...(entry.startLine === entry.line ? {} : { start_line: entry.startLine, start_side: entry.side }),
    });
  }
  createFileComment(repo, number, entry, body, sha) {
    return this.request('POST', `/repos/${repo}/pulls/${positiveInteger(number, 'Pull request number')}/comments`, {
      body, commit_id: sha, path: entry.path, subject_type: 'file',
    });
  }
  createReviewReply(repo, number, parentId, body) {
    return this.request('POST', `/repos/${repo}/pulls/${positiveInteger(number, 'Pull request number')}/comments/${positiveInteger(parentId, 'Reply parent ID')}/replies`, { body });
  }
  listReviewComments(repo, number) { return this.paginate(`/repos/${repo}/pulls/${positiveInteger(number, 'Pull request number')}/comments`); }
  createReview(repo, number, body) { return this.request('POST', `/repos/${repo}/pulls/${positiveInteger(number, 'Pull request number')}/reviews`, body); }
  listReviews(repo, number) { return this.paginate(`/repos/${repo}/pulls/${positiveInteger(number, 'Pull request number')}/reviews`); }
  listReviewCommentsForReview(repo, number, reviewId) {
    return this.paginate(`/repos/${repo}/pulls/${positiveInteger(number, 'Pull request number')}/reviews/${positiveInteger(reviewId, 'Review ID')}/comments`);
  }
  listFiles(repo, number) { return this.paginate(`/repos/${repo}/pulls/${positiveInteger(number, 'Pull request number')}/files`); }
}

/** Resolve the destination PR and use its authoritative head commit for links. */
export async function resolveContext({ repo: explicitRepo, pr, cwd = process.cwd(), env = process.env, github, run = execute, readFile = fsReadFile } = {}) {
  const serverUrl = env.GITHUB_SERVER_URL || DEFAULT_SERVER;
  const parsed = pr === undefined ? undefined : parsePullRequest(pr, { serverUrl });
  const requestedRepo = explicitRepo ? parseRepo(explicitRepo, { serverUrl }) : undefined;
  if (requestedRepo && parsed?.repo && requestedRepo.toLowerCase() !== parsed.repo.toLowerCase()) {
    throw new Error('--repo does not match the repository in the pull request URL.');
  }
  let repo = requestedRepo || parsed?.repo;
  let number = parsed?.number;
  let event;
  if (env.GITHUB_EVENT_PATH && (!repo || !number)) {
    try { event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')); }
    catch { throw new Error('Could not read a valid GitHub Actions event from GITHUB_EVENT_PATH. Pass --repo and --pr explicitly.'); }
  }
  const eventRepo = event?.pull_request?.base?.repo?.full_name || event?.repository?.full_name || env.GITHUB_REPOSITORY;
  if (!repo && eventRepo) repo = parseRepo(eventRepo, { serverUrl });
  if (!number && (!eventRepo || !repo || eventRepo.toLowerCase() === repo.toLowerCase())) {
    number = event?.pull_request?.number || (event?.pull_request ? event.number : undefined)
      || (event?.issue?.pull_request ? event.issue.number : undefined);
  }
  const git = async (...args) => {
    try { return await run('git', args, { cwd, env }); } catch { return undefined; }
  };
  let originRepo;
  let branch;
  if (!repo || !number) {
    const remote = await git('remote', 'get-url', 'origin');
    if (remote) {
      try { originRepo = parseRepo(remote, { serverUrl }); } catch { /* An explicit repository can still be used. */ }
    }
    if (!repo) {
      const upstream = await git('remote', 'get-url', 'upstream');
      if (upstream) {
        try { repo = parseRepo(upstream, { serverUrl }); } catch { /* Fall back to origin. */ }
      }
      repo ||= originRepo;
    }
  }
  if (!repo) throw new Error('Could not determine the repository. Pass --repo owner/repo or a complete --pr URL.');
  github ||= new GitHub({
    token: await resolveToken({ env, run, serverUrl }),
    apiUrl: env.GITHUB_API_URL || DEFAULT_API,
  });
  if (!number) {
    branch = await git('branch', '--show-current');
    if (!branch) throw new Error('Could not determine the current branch (the checkout may be detached). Pass --pr explicitly.');
    const headOwner = (originRepo || repo).split('/')[0];
    number = (await github.findPull(repo, `${headOwner}:${branch}`)).number;
  }
  number = positiveInteger(number, 'Pull request number');
  const pull = await github.getPull(repo, number);
  if (!/^[a-f0-9]{40}$/i.test(pull?.head?.sha || '')) throw new Error('GitHub did not return a valid pull request head commit.');
  return {
    repo, number, headSha: pull.head.sha,
    headRepo: pull.head.repo?.full_name || repo, headRef: pull.head.ref,
    baseSha: pull.base?.sha, baseRef: pull.base?.ref,
    pull, github, serverUrl,
  };
}

/** Fields consumed by the CLI. Values are checked at the JSON boundary. */
export interface GitHubObject {
  [key: string]: unknown;
  id?: number;
  databaseId?: number;
  number?: number;
  login?: string;
  body?: string | null;
  html_url?: string;
  full_name?: string;
  sha?: string;
  ref?: string;
  changed_files?: number;
  filename?: string;
  patch?: string;
  path?: string;
  side?: string;
  start_side?: string | null;
  line?: number | null;
  start_line?: number | null;
  position?: number | null;
  in_reply_to_id?: number;
  pull_request_review_id?: number | null;
  pull_request_url?: string;
  subject_type?: string;
  state?: string;
  commit_id?: string | null;
  user?: GitHubObject | null;
  head?: GitHubObject | null;
  base?: GitHubObject | null;
  repo?: GitHubObject | null;
  repository?: GitHubObject | null;
  pull_request?: GitHubObject | null;
  issue?: GitHubObject | null;
  data?: GitHubObject | null;
  viewer?: GitHubObject | null;
  permissions?: GitHubObject | null;
}
const strings = new Set(['login', 'html_url', 'full_name', 'sha', 'ref', 'filename', 'patch', 'path', 'side', 'pull_request_url', 'subject_type', 'state']);
const numbers = new Set(['id', 'databaseId', 'number', 'changed_files', 'in_reply_to_id']);
const nullableNumbers = new Set(['line', 'start_line', 'position', 'pull_request_review_id']);
const objects = new Set(['user', 'head', 'base', 'repo', 'repository', 'pull_request', 'issue', 'data', 'viewer', 'permissions']);
export function isGitHubObject(value: unknown): value is GitHubObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    if (strings.has(key) && typeof field !== 'string') return false;
    if ((key === 'start_side' || key === 'commit_id') && field !== null && typeof field !== 'string') return false;
    if (numbers.has(key) && typeof field !== 'number') return false;
    if (nullableNumbers.has(key) && field !== null && typeof field !== 'number') return false;
    if (key === 'body' && field !== null && typeof field !== 'string') return false;
    if (objects.has(key) && field !== null && !isGitHubObject(field)) return false;
  }
  return true;
}
export function githubObject(value: unknown): GitHubObject {
  if (!isGitHubObject(value)) throw new Error('GitHub returned an invalid response object.');
  return value;
}
export function errorMessage(error: unknown): unknown {
  return error && typeof error === 'object' && 'message' in error ? error.message : undefined;
}

export type GitHubContext<T extends import('./github.js').ContextGitHub = import('./github.js').GitHub> = Awaited<ReturnType<typeof import('./github.js').resolveContext<T>>>;

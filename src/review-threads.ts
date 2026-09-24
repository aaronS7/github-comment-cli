import type { CommentEntry, Side } from './types.js';
import type { GitHub } from './github.js';
import { errorMessage, type GitHubObject } from './github-types.js';
type Hunk = Record<Side, Set<number>>;
export type ReviewTargetGitHub = Pick<GitHub, 'listFiles'>;
export type ReplyTargetGitHub = Pick<GitHub, 'listReviewComments'>;
type TargetContext<T> = { github: T; repo: string; pr: number; pull?: GitHubObject };
/** Read the exact lines exposed by GitHub's current pull request diff. */
export function parseDiffHunks(patch: unknown) {
  if (typeof patch !== 'string' || !patch.trim()) throw new Error('GitHub did not provide a readable diff patch.');
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldEnd = 0;
  let newEnd = 0;
  const complete = () => {
    if (hunk && (oldLine !== oldEnd || newLine !== newEnd)) {
      throw new Error('GitHub provided an incomplete diff patch.');
    }
  };
  for (const row of patch.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')) {
    if (row.startsWith('@@ ')) {
      complete();
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
      if (!header) throw new Error('GitHub provided an invalid diff hunk header.');
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldEnd = oldLine + Number(header[2] ?? 1);
      newEnd = newLine + Number(header[4] ?? 1);
      if (![oldLine, newLine, oldEnd, newEnd].every(Number.isSafeInteger)) {
        throw new Error('GitHub provided an invalid diff line number.');
      }
      hunk = { LEFT: new Set(), RIGHT: new Set() };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) throw new Error('GitHub provided a diff patch without a hunk header.');
    if (row.startsWith('\\ No newline at end of file')) continue;
    switch (row[0]) {
      case ' ':
        oldLine++;
        hunk.RIGHT.add(newLine++);
        break;
      case '-':
        hunk.LEFT.add(oldLine++);
        break;
      case '+':
        hunk.RIGHT.add(newLine++);
        break;
      default:
        throw new Error('GitHub provided an invalid diff patch line.');
    }
    if (oldLine > oldEnd || newLine > newEnd) throw new Error('GitHub provided an inconsistent diff patch.');
  }
  complete();
  if (!hunks.length) throw new Error('GitHub did not provide any diff hunks.');
  return hunks;
}

/** Reject stale or ambiguous targets before any comment or attachment upload. */
export async function validateReviewTargets(comments: CommentEntry[], { github, repo, pr, pull }: TargetContext<ReviewTargetGitHub>) {
  const targets = comments.filter(entry => entry.kind === 'thread' || entry.kind === 'file');
  if (!targets.length) return;
  const files = await github.listFiles(repo, pr);
  if (!Array.isArray(files) || (Number.isSafeInteger(pull?.changed_files) && (pull?.changed_files ?? 0) > files.length)) {
    throw new Error('GitHub did not return the complete pull request file list. Cannot validate review targets.');
  }
  const byPath = new Map(files.map(file => [file.filename, file]));
  const hunksByPath = new Map<string, Hunk[]>();
  for (const entry of targets) {
    const file = byPath.get(entry.path);
    if (!file) throw new Error(`Review ${entry.kind} target "${entry.path}" is not a changed file in this pull request.`);
    if (entry.kind === 'file') continue;
    if (!['LEFT', 'RIGHT'].includes(entry.side) || !Number.isSafeInteger(entry.startLine)
      || !Number.isSafeInteger(entry.line) || entry.startLine < 1 || entry.line < entry.startLine) {
      throw new Error('Review thread placement is invalid.');
    }
    if (!hunksByPath.has(entry.path)) {
      try { hunksByPath.set(entry.path, parseDiffHunks(file.patch)); }
      catch (error) { throw new Error(`Cannot validate review thread target "${entry.path}": ${errorMessage(error)}`, { cause: error }); }
    }
    const valid = hunksByPath.get(entry.path)!.some(hunk => {
      const lines = hunk[entry.side];
      if (!lines.has(entry.startLine) || !lines.has(entry.line)) return false;
      for (let line = entry.startLine + 1; line < entry.line; line++) {
        if (!lines.has(line)) return false;
      }
      return true;
    });
    if (!valid) {
      const range = entry.startLine === entry.line ? `${entry.line}` : `${entry.startLine}-${entry.line}`;
      throw new Error(`Review thread target "${entry.path}" ${entry.side} line ${range} is not one contiguous range in the current pull request diff.`);
    }
  }
}

export const validateThreadTargets = validateReviewTargets;

/** The PR-scoped list proves the parent belongs to this PR and is a top-level thread. */
export async function validateReplyTargets(comments: CommentEntry[], { github, repo, pr }: TargetContext<ReplyTargetGitHub>) {
  const replies = comments.filter(entry => entry.kind === 'reply');
  if (!replies.length) return;
  const remote = await github.listReviewComments(repo, pr);
  if (!Array.isArray(remote)) throw new Error('GitHub did not return the pull request review comments. Cannot validate replies.');
  const byId = new Map(remote.map(comment => [comment.id, comment]));
  for (const entry of replies) {
    const parent = byId.get(entry.parentId);
    if (!parent) throw new Error(`Reply parent ${entry.parentId} is not a review comment on this pull request.`);
    if (parent.in_reply_to_id) throw new Error(`Reply parent ${entry.parentId} is itself a reply. Use the top-level review comment ID.`);
    if (parent.pull_request_url) {
      let pathname;
      try { pathname = new URL(parent.pull_request_url).pathname; } catch { /* Invalid metadata is rejected below. */ }
      if (pathname?.toLowerCase() !== `/repos/${repo}/pulls/${pr}`.toLowerCase()) {
        throw new Error(`Reply parent ${entry.parentId} does not belong to this pull request.`);
      }
    }
  }
}

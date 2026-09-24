import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommentEntry, Side } from '../src/types.js';
import { validateReplyTargets, validateReviewTargets, validateThreadTargets } from '../src/review-threads.js';

const patch = '@@ -10,3 +10,4 @@\n alpha\n-beta\n+beta updated\n+extra\n gamma';
const context = {
  repo: 'example/project', pr: 12, pull: { changed_files: 1 },
  github: { async listFiles() { return [{ filename: 'src/file.js', patch }]; } },
} as unknown as Parameters<typeof validateThreadTargets>[1];
const thread = (side: Side, startLine: number, line = startLine): Extract<CommentEntry, { kind: 'thread' }> => ({
  kind: 'thread', path: 'src/file.js', side, startLine, line, body: 'Check this.',
});

test('review targets accept contiguous lines on either side of a changed hunk', async () => {
  await validateThreadTargets([thread('RIGHT', 11, 13), thread('LEFT', 11)], context);
});

test('review targets reject missing lines and unchanged files before publication', async () => {
  await assert.rejects(validateThreadTargets([thread('LEFT', 13)], context), /not one contiguous range/);
  await assert.rejects(validateThreadTargets([{ ...thread('RIGHT', 11), path: 'other.js' }], context), /not a changed file/);
});

test('file comments need a changed path but can target a file without a readable patch', async () => {
  await validateReviewTargets([{ kind: 'file', path: 'src/file.js', body: 'Whole-file note.' }], {
    ...context, github: { async listFiles() { return [{ filename: 'src/file.js' }]; } },
  });
  await assert.rejects(validateReviewTargets([{ kind: 'file', path: 'other.js', body: '' }], context), /not a changed file/);
});

test('replies require a top-level parent in the target PR', async () => {
  const parents = [
    { id: 100, pull_request_url: 'https://api.github.com/repos/example/project/pulls/12' },
    { id: 101, in_reply_to_id: 100 },
    { id: 102, pull_request_url: 'https://api.github.com/repos/example/project/pulls/13' },
  ];
  const target = { ...context, github: { async listReviewComments() { return parents; } } };
  await validateReplyTargets([{ kind: 'reply', parentId: 100, body: '' }], target);
  await assert.rejects(validateReplyTargets([{ kind: 'reply', parentId: 101, body: '' }], target), /itself a reply/);
  await assert.rejects(validateReplyTargets([{ kind: 'reply', parentId: 102, body: '' }], target), /does not belong/);
  await assert.rejects(validateReplyTargets([{ kind: 'reply', parentId: 999, body: '' }], target), /not a review comment/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateThreadTargets } from '../src/review-threads.js';

const patch = '@@ -10,3 +10,4 @@\n alpha\n-beta\n+beta updated\n+extra\n gamma';
const context = {
  repo: 'example/project', pr: 12, pull: { changed_files: 1 },
  github: { async listFiles() { return [{ filename: 'src/file.js', patch }]; } },
};
const thread = (side, startLine, line = startLine) => ({
  kind: 'thread', path: 'src/file.js', side, startLine, line, body: 'Check this.',
});

test('review targets accept contiguous lines on either side of a changed hunk', async () => {
  await validateThreadTargets([thread('RIGHT', 11, 13), thread('LEFT', 11)], context);
});

test('review targets reject missing lines and unchanged files before publication', async () => {
  await assert.rejects(validateThreadTargets([thread('LEFT', 13)], context), /not one contiguous range/);
  await assert.rejects(validateThreadTargets([{ ...thread('RIGHT', 11), path: 'other.js' }], context), /not a changed file/);
});

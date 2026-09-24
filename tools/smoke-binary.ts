import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const binary = path.join(root, 'dist', `gh-comment-v${version}-${platform}-${process.arch}${platform === 'windows' ? '.exe' : ''}`);
const run = (...args: string[]): string => {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Binary failed.');
  return result.stdout;
};

assert.equal(run('--version').trim(), version);
assert.match(run('render', 'examples/review.md', '--repo', 'aaronS7/github-comment-cli'), /github\.com\/aaronS7\/github-comment-cli\/blob\/[a-f0-9]{40}\/examples\/demo\.js#L3-L5/);

const temporary = await mkdtemp(path.join(tmpdir(), 'gh-comment-smoke-'));
try {
  const html = path.join(temporary, 'preview.html');
  assert.equal(run('preview', 'examples/review.md', '--repo', 'aaronS7/github-comment-cli', '--output', html).trim(), html);
  assert.match(await readFile(html, 'utf8'), /Input validation/);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
process.stdout.write('Binary smoke tests passed.\n');

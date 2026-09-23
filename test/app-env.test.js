import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { saveTokenToEnv } from '../src/app-env.js';

test('token replacement preserves other settings and installs a private complete file', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'gh-comment-app-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envPath = path.join(root, '.env');
  await writeFile(envPath, 'GH_REPO=owner/repo\nGH_TOKEN=old\nGH_TOKEN=stale\n', { mode: 0o644 });

  assert.equal(await saveTokenToEnv('new-token', envPath), envPath);
  assert.equal(await readFile(envPath, 'utf8'), 'GH_REPO=owner/repo\nGH_TOKEN=new-token\n');
  if (process.platform !== 'win32') assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), ['.env']);
});

test('token save rejects a symlink without modifying its target', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'gh-comment-app-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = path.join(root, 'actual');
  const envPath = path.join(root, '.env');
  await writeFile(actual, 'GH_TOKEN=old\n');
  await symlink(actual, envPath);

  await assert.rejects(saveTokenToEnv('new-token', envPath), /regular file/);
  assert.equal(await readFile(actual, 'utf8'), 'GH_TOKEN=old\n');
  assert.deepEqual((await readdir(root)).sort(), ['.env', 'actual']);
});

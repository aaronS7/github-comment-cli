import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { parseGitHubRemote, parseLocalReference, Repository } from '../src/git.js';

const exec = promisify(execFile);

async function fixture(t: TestContext, files: Record<string, string> = { 'src/example.js': 'one\ntwo\nthree\n', 'README.md': '# Read me\n\nDetails.\n' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gh-comment-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '--quiet');
  await git('config', 'user.name', 'Test Author');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'commit.gpgSign', 'false');
  await git('remote', 'add', 'origin', 'git@github.com:example/project.git');
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), body);
  }
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'Initial files');
  return { root, git, repository: await Repository.discover(root), sha: await git('rev-parse', 'HEAD') };
}

test('parses local line destinations and leaves web URLs and headings alone', () => {
  assert.deepEqual(parseLocalReference('src/example.js:12'), { path: 'src/example.js', startLine: 12, endLine: 12 });
  assert.deepEqual(parseLocalReference('README.md:12-15'), { path: 'README.md', startLine: 12, endLine: 15 });
  assert.deepEqual(parseLocalReference('src/example.js#L12-L15'), { path: 'src/example.js', startLine: 12, endLine: 15 });
  assert.deepEqual(parseLocalReference('/work/src/my%20file.js#L2'), { path: '/work/src/my file.js', startLine: 2, endLine: 2 });
  const filePath = path.join(path.parse(process.cwd()).root, 'work', 'src', 'example.js');
  assert.deepEqual(parseLocalReference(`${pathToFileURL(filePath).href}:2-3`), { path: filePath, startLine: 2, endLine: 3 });
  const windowsPath = 'C:\\Users\\runner\\src\\example.js';
  assert.deepEqual(parseLocalReference(`${windowsPath}:2`), { path: windowsPath, startLine: 2, endLine: 2 });
  assert.deepEqual(parseLocalReference('README.md'), { path: 'README.md', startLine: undefined, endLine: undefined });
  for (const value of ['https://github.com/example/project/blob/abc/file.js#L12', 'mailto:a@example.com', 'tel:1234', 'sms:1234', 'http:80', '#heading', '//example.com/file:12', 'docs.md#heading', 'docs.md?raw=1']) {
    assert.equal(parseLocalReference(value), null, value);
  }
  for (const value of ['src/a.js:0', 'src/a.js:9-3', 'src/a.js#L0', 'src/a.js:999999999999999999', 'src/%00.js:1']) {
    assert.throws(() => parseLocalReference(value), { name: 'RepositoryError' }, value);
  }
});

test('parses github.com HTTPS and SSH remotes without exposing credentials on errors', () => {
  for (const value of ['git@github.com:example/project.git', 'https://github.com/example/project.git', 'ssh://git@github.com/example/project', 'https://github.com/example/project/']) {
    assert.deepEqual(parseGitHubRemote(value), { owner: 'example', repo: 'project', fullName: 'example/project', webUrl: 'https://github.com/example/project' });
  }
  for (const value of ['https://github.example.com/a/b', 'https://github.com.evil.invalid/a/b', 'https://secret@example.invalid/a/b', 'file:///tmp/project', 'https://github.com/a/b/tree/main']) {
    assert.throws(() => parseGitHubRemote(value), (error: unknown) => {
      if (!(error instanceof Error)) return false;
      return error.name === 'RepositoryError' && !error.message.includes('secret');
    });
  }
});

test('discovers checkout from a subdirectory and pins line ranges to full commits', async t => {
  const { root, sha } = await fixture(t);
  const repository = await Repository.discover(path.join(root, 'src'));
  assert.equal(repository.root, await realpath(root));
  assert.equal(await repository.head(), sha);
  assert.equal((await repository.remote()).fullName, 'example/project');
  assert.deepEqual(await repository.resolveReference('src/example.js:2-3'), {
    url: `https://github.com/example/project/blob/${sha}/src/example.js#L2-L3`,
    path: 'src/example.js', startLine: 2, endLine: 3,
  });
  assert.equal((await repository.resolveReference(path.join(root, 'src/example.js') + '#L1')).url, `https://github.com/example/project/blob/${sha}/src/example.js#L1`);
  assert.equal((await repository.resolveReference('README.md#L1', { repo: 'another/fork', sha: 'HEAD' })).url, `https://github.com/another/fork/blob/${sha}/README.md?plain=1#L1`);
});

test('accepts absolute references spelled through an alias of the checkout root', async t => {
  const { root, repository } = await fixture(t);
  const alias = `${root}-alias`;
  t.after(() => rm(alias, { recursive: true, force: true }));
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const resolved = await repository.resolveReference(path.join(alias, 'src/example.js:2'));
  assert.equal(resolved.path, 'src/example.js');
  assert.equal(resolved.startLine, 2);
});

test('encodes filenames while preserving path separators', async t => {
  const { repository, sha } = await fixture(t, { 'src/file #1.js': 'line\n', 'src/file [x].js': 'line\n', 'src/file (x).js': 'line\n', 'src/file).js': 'line\n' });
  assert.equal((await repository.resolveReference('src/file%20%231.js:1')).url, `https://github.com/example/project/blob/${sha}/src/file%20%231.js#L1`);
  assert.equal((await repository.resolveReference('src/file [x].js:1')).url, `https://github.com/example/project/blob/${sha}/src/file%20%5Bx%5D.js#L1`);
  assert.equal((await repository.resolveReference('src/file (x).js:1')).url, `https://github.com/example/project/blob/${sha}/src/file%20%28x%29.js#L1`);
  assert.equal((await repository.resolveReference('src/file).js:1')).url, `https://github.com/example/project/blob/${sha}/src/file%29.js#L1`);
});

test('rejects missing, untracked, outside-repository, directory, and symlink references', async t => {
  const { repository, root } = await fixture(t);
  await writeFile(path.join(root, 'untracked.js'), 'hello\n');
  await symlink(path.join(root, 'src/example.js'), path.join(root, 'linked.js'));
  const cases = [
    ['missing.js:1', 'MISSING_FILE'], ['untracked.js:1', 'UNTRACKED_FILE'],
    ['../outside.js:1', 'OUTSIDE_REPOSITORY'], ['/etc/passwd:1', 'OUTSIDE_REPOSITORY'],
    ['src:1', 'INVALID_FILE'], ['linked.js:1', 'INVALID_FILE'],
  ];
  for (const [target, code] of cases) await assert.rejects(repository.resolveReference(target), { code }, target);
});

test('validates line bounds including final newlines, empty files, and binary files', async t => {
  const { repository } = await fixture(t, { 'newline.js': 'a\nb\n', 'no-newline.js': 'a\nb', 'empty.js': '', 'binary.dat': 'a\0b\n' });
  for (const name of ['newline.js', 'no-newline.js']) {
    assert.equal((await repository.resolveReference(`${name}:2`)).endLine, 2);
    await assert.rejects(repository.resolveReference(`${name}:3`), { code: 'LINE_OUT_OF_BOUNDS' });
  }
  await assert.rejects(repository.resolveReference('empty.js:1'), { code: 'LINE_OUT_OF_BOUNDS' });
  await assert.rejects(repository.resolveReference('binary.dat:1'), { code: 'BINARY_FILE' });
});

test('rejects unstaged and staged content changes but permits unrelated changes', async t => {
  const { repository, root, git } = await fixture(t);
  await writeFile(path.join(root, 'README.md'), 'changed\n');
  assert.equal((await repository.resolveReference('src/example.js:1')).startLine, 1);
  await writeFile(path.join(root, 'src/example.js'), 'inserted\none\ntwo\nthree\n');
  await assert.rejects(repository.resolveReference('src/example.js:2'), { code: 'DIRTY_REFERENCE' });
  await git('add', 'src/example.js');
  await assert.rejects(repository.resolveReference('src/example.js:2'), { code: 'DIRTY_REFERENCE' });
});

test('permits CRLF conversion when local line contents and numbers match', async t => {
  const { repository, root } = await fixture(t);
  await writeFile(path.join(root, 'src/example.js'), 'one\r\ntwo\r\nthree\r\n');
  assert.equal((await repository.resolveReference('src/example.js:2-3')).endLine, 3);
  await writeFile(path.join(root, 'src/example.js'), 'one\r\n\r\ntwo\r\nthree\r\n');
  await assert.rejects(repository.resolveReference('src/example.js:3'), { code: 'DIRTY_REFERENCE' });
});

test('checks references against selected commit rather than local HEAD', async t => {
  const { repository, root, git, sha } = await fixture(t);
  await writeFile(path.join(root, 'src/example.js'), 'changed\ntwo\nthree\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'Change file');
  await assert.rejects(repository.resolveReference('src/example.js:1', { sha }), { code: 'DIRTY_REFERENCE' });
  assert.match((await repository.resolveReference('README.md:1', { sha })).url, new RegExp(`/blob/${sha}/`));
  await assert.rejects(repository.resolveReference('README.md:1', { sha: 'f'.repeat(40) }), { code: 'MISSING_COMMIT' });
  await assert.rejects(repository.resolveReference('README.md:1', { sha: '--output=evil' }), { code: 'MISSING_COMMIT' });
});

test('supports a sole non-origin remote and explicit repository without a remote', async t => {
  const { repository, git } = await fixture(t);
  await git('remote', 'rename', 'origin', 'upstream');
  assert.equal((await repository.remote()).fullName, 'example/project');
  await git('remote', 'remove', 'upstream');
  await assert.rejects(repository.remote(), { code: 'MISSING_REMOTE' });
  assert.match((await repository.resolveReference('README.md:1', { repo: { owner: 'other', repo: 'project' } })).url, /^https:\/\/github\.com\/other\/project\//);
});

test('rejects encoded traversal and symlinked directory escapes', async t => {
  const { repository, root } = await fixture(t);
  for (const target of ['%2E%2E/outside.js:1', '..%2Foutside.js:1', '%2Fetc%2Fpasswd:1']) {
    await assert.rejects(repository.resolveReference(target), { code: 'OUTSIDE_REPOSITORY' });
  }
  const external = await mkdtemp(path.join(os.tmpdir(), 'gh-comment-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, 'passwd'), 'outside\n');
  await symlink(external, path.join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(repository.resolveReference('external/passwd:1'), { code: 'OUTSIDE_REPOSITORY' });
});

test('treats shell metacharacters and Git pathspec characters as literal filenames', async t => {
  const { repository, root } = await fixture(t, { 'src/$(touch owned).js': 'line\n', 'src/[a].js': 'line\n' });
  assert.equal((await repository.resolveReference('src/$(touch owned).js:1')).path, 'src/$(touch owned).js');
  assert.equal((await repository.resolveReference('src/[a].js:1')).path, 'src/[a].js');
  await assert.rejects(access(path.join(root, 'owned')), { code: 'ENOENT' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { main } from '../src/cli.js';
import { GitHub } from '../src/github.js';

const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gh-comment-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '-q');
  await git('config', 'user.name', 'CLI tests');
  await git('config', 'user.email', 'cli@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/file.js'), 'one\ntwo\nthree\n');
  await git('add', '.');
  await git('commit', '-qm', 'fixture');
  await git('remote', 'add', 'origin', 'git@github.com:example/project.git');
  return { root, git, sha: await git('rev-parse', 'HEAD') };
}

async function invoke(args, options = {}) {
  let stdout = '';
  let stderr = '';
  const status = await main(args, { env: {}, ...options,
    stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } },
  });
  return { status, stdout, stderr };
}

function api(sha, { headRepo = 'example/project', comments = [], nextComments, viewer = { id: 42, login: 'tester' }, failWrite = 0, changedHead = false } = {}) {
  const calls = [];
  let pullReads = 0;
  let writes = 0;
  const github = new GitHub({ token: 'unit-test-token', fetch: async (url, init) => {
    const pathname = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: pathname, method: init.method, body });
    let data;
    const headers = {};
    if (init.method === 'GET' && pathname.endsWith('/pulls/12')) {
      pullReads++;
      data = { number: 12, head: { sha: changedHead && pullReads > 1 ? 'b'.repeat(40) : sha, repo: { full_name: headRepo }, ref: 'topic' } };
    } else if (pathname === '/user') data = viewer;
    else if (init.method === 'GET' && pathname.endsWith('/comments')) {
      data = new URL(url).searchParams.get('page') === '2' ? nextComments : comments;
      if (nextComments && new URL(url).searchParams.get('page') !== '2') {
        headers.link = `<https://api.github.com${pathname}?per_page=100&page=2>; rel="next"`;
      }
    }
    else if (['POST', 'PATCH'].includes(init.method) && pathname.includes('/comments')) {
      writes++;
      if (writes === failWrite) return Response.json({ message: 'API unavailable' }, { status: 503 });
      data = { id: writes + 100, html_url: `https://github.com/example/project/pull/12#issuecomment-${writes + 100}`, body: body.body, user: viewer };
    } else throw new Error(`Unexpected request ${init.method} ${url}`);
    return Response.json(data, { headers });
  } });
  return { github, calls };
}

test('offline CLI renders a commit permalink and leaves code examples untouched', async t => {
  const { root, sha } = await fixture(t);
  const markdown = '# Notes\n\n[code](src/file.js:2-3 "source")\n\n`[literal](src/file.js:900)`\n';
  await writeFile(path.join(root, 'review.md'), markdown);
  const result = await invoke(['render', 'review.md'], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`/blob/${sha}/src/file.js#L2-L3`));
  assert.ok(result.stdout.includes(' "source")'));
  assert.ok(result.stdout.includes('`[literal](src/file.js:900)`'));
});

test('stdin preserves unicode across byte chunk boundaries and emits parseable JSON', async t => {
  const { root, sha } = await fixture(t);
  const bytes = Buffer.from('👩🏽‍💻 [code](src/file.js#L1)');
  const result = await invoke(['render', '-', '--json'], { cwd: root, stdin: Readable.from([...bytes].map(byte => Buffer.from([byte]))) });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sha, sha);
  assert.equal(output.repo, 'example/project');
  assert.equal(output.pr, null);
  assert.ok(output.comments[0].body.startsWith('👩🏽‍💻 '));
});

test('--cwd selects the code checkout while input file stays relative to invocation directory', async t => {
  const { root } = await fixture(t);
  const caller = path.join(root, 'reports');
  await mkdir(caller);
  await writeFile(path.join(caller, 'review.md'), '[source](src/file.js:1)');
  const result = await invoke(['render', 'review.md', '--cwd', root], { cwd: caller });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/src\/file.js#L1/);
});

test('post --dry-run uses fork head commit without making writes', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha, { headRepo: 'contributor/fork' });
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--dry-run', '--json'], {
    cwd: root, ...mock, markdown: '[source](src/file.js:2)',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.pr, 12);
  assert.match(output.comments[0].body, /github.com\/contributor\/fork\/blob\//);
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('publishes multiple Markdown entries in order as PR conversation comments', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha);
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--json'], {
    cwd: root, ...mock, markdown: 'First [line](src/file.js:1)\n\n<!-- gh-comment:next -->\n\nSecond [line](src/file.js:3)',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).comments.length, 2);
  const writes = mock.calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].path, '/repos/example/project/issues/12/comments');
  assert.match(writes[0].body.body, /^First .*#L1/);
  assert.match(writes[1].body.body, /^Second .*#L3/);
});

test('an invalid later entry prevents every write', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha);
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12'], {
    cwd: root, ...mock, markdown: 'Valid\n\n<!-- gh-comment:next -->\n\n[Invalid](src/file.js:999)',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Line 999 is outside/);
  assert.equal(result.stdout, '');
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('a dirty referenced file prevents publication', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha);
  await writeFile(path.join(root, 'src/file.js'), 'inserted\none\ntwo\nthree\n');
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12'], {
    cwd: root, ...mock, markdown: '[Source](src/file.js:2)',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /differs from/);
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('PR head change during rendering stops publication', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha, { changedHead: true });
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12'], { cwd: root, ...mock, markdown: 'Report' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /head changed/);
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('keyed comments update only the authenticated author and skip unchanged content', async t => {
  const { root, sha } = await fixture(t);
  const marker = '<!-- gh-comment:key:report -->';
  const own = { id: 123, user: { id: 42 }, body: `Old\n\n${marker}`, html_url: 'https://github.com/example/project/pull/12#issuecomment-123' };
  const other = { ...own, id: 124, user: { id: 43 } };
  const options = ['post', '-', '--repo', 'example/project', '--pr', '12', '--key', 'report', '--json'];
  const mock = api(sha, { comments: [other, own] });
  const updated = await invoke(options, { cwd: root, ...mock, markdown: 'New' });
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(JSON.parse(updated.stdout).comments[0].action, 'updated');
  assert.equal(mock.calls.find(call => call.method === 'PATCH').path, '/repos/example/project/issues/comments/123');
  const unchangedMock = api(sha, { comments: [other, { ...own, body: `New\n\n${marker}` }] });
  const unchanged = await invoke(options, { cwd: root, ...unchangedMock, markdown: 'New' });
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(JSON.parse(unchanged.stdout).comments[0].action, 'unchanged');
  assert.ok(unchangedMock.calls.every(call => call.method === 'GET'));
});

test('keyed comments create when missing and fail on duplicate owned matches', async t => {
  const { root, sha } = await fixture(t);
  const options = ['post', '-', '--repo', 'example/project', '--pr', '12', '--key', 'report'];
  const mock = api(sha);
  const created = await invoke(options, { cwd: root, ...mock, markdown: 'New' });
  assert.equal(created.status, 0, created.stderr);
  assert.match(mock.calls.find(call => call.method === 'POST').body.body, /<!-- gh-comment:key:report -->$/);
  const comment = { id: 12, user: { id: 42 }, body: 'Old\n\n<!-- gh-comment:key:report -->' };
  const duplicate = api(sha, { comments: [comment, { ...comment, id: 13 }] });
  const failed = await invoke(options, { cwd: root, ...duplicate, markdown: 'New' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Multiple comments/);
  assert.ok(duplicate.calls.every(call => call.method === 'GET'));
});

test('keyed multi-entry report fails before publication', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha);
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--key', 'report'], {
    cwd: root, ...mock, markdown: 'One\n\n<!-- gh-comment:next -->\n\nTwo',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a single comment/);
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('key markers in code examples never select an unrelated comment for update', async t => {
  const { root, sha } = await fixture(t);
  const example = { id: 123, user: { id: 42 }, body: 'Example:\n\n```markdown\n<!-- gh-comment:key:report -->\n```' };
  const mock = api(sha, { comments: [example] });
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--key', 'report', '--json'], {
    cwd: root, ...mock, markdown: 'Real report',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).comments[0].action, 'created');
  assert.ok(!mock.calls.some(call => call.method === 'PATCH'));
});

test('an unfinished code fence cannot hide the upsert marker', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha);
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--key', 'report'], {
    cwd: root, ...mock, markdown: 'Report\n\n```js\nconst value = 1;',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unfinished code fence/);
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('partial publication reports completed URLs and never retries writes', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha, { failWrite: 2 });
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12'], {
    cwd: root, ...mock, markdown: 'One\n\n<!-- gh-comment:next -->\n\nTwo\n\n<!-- gh-comment:next -->\n\nThree',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Published 1 of 3/);
  assert.match(result.stderr, /#issuecomment-101/);
  assert.equal(mock.calls.filter(call => call.method === 'POST').length, 2);
});

test('plain comments work without a local checkout when the destination is explicit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'gh-comment-plain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mock = api('a'.repeat(40));
  const result = await invoke(['post', '-', '--pr', 'https://github.com/example/project/pull/12'], { cwd: root, ...mock, markdown: 'Plain report' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /issuecomment/);
});

test('CLI usage validation runs without repository or network access', async () => {
  for (const args of [[], ['wrong', 'file.md'], ['post', 'file.md', '--sha', 'HEAD'], ['render', 'file.md', '--dry-run'], ['post', 'file.md', '--key', 'bad key'], ['render', 'file.md', '--unknown'], ['post', 'file.md', '--dedupe', 'yes'], ['post', 'file.md', '--similarity-threshold', '96'], ['post', 'file.md', '--similarity-threshold', '0'], ['post', 'file.md', '--similarity-threshold', 'NaN'], ['post', 'file.md', '--similarity-threshold', '0x1'], ['post', 'file.md', '--config', '']]) {
    const result = await invoke(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^gh-comment:/);
  }
  assert.equal((await invoke(['--help'])).status, 0);
  assert.equal((await invoke(['--version'])).stdout, '0.1.0\n');
});

const duplicateUrl = 'https://github.com/example/project/pull/12#issuecomment-55';
const existingComment = body => ({ id: 55, body, user: { id: 42 }, html_url: duplicateUrl });
const reportText = 'The current implementation correctly validates the input before creating a request and returns a useful explanation when the data cannot be processed. Please keep the validation close to the entry point so future callers can use the same behavior without adding their own checks or copying this logic elsewhere for maintainers.';
const revisedReport = reportText.replace('useful explanation', 'clear explanation');

test('default exact dedupe explains a skipped entry and returns its existing URL', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha, { comments: [existingComment('Report')] });
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12'], { cwd: root, ...mock, markdown: 'Report' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${duplicateUrl}\n`);
  assert.match(result.stderr, /Skipped comment 1 \(exact duplicate, 100% match\)/);
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('duplicate detection searches every page of existing comments', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha, { comments: [{ ...existingComment('Other content'), id: 54 }], nextComments: [existingComment('Report')] });
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--json'], { cwd: root, ...mock, markdown: 'Report' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).comments[0].id, 55);
  assert.equal(mock.calls.filter(call => call.path.endsWith('/comments')).length, 2);
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('similar mode exposes reason, score, and existing URL through JSON', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha, { comments: [existingComment(reportText)] });
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--dedupe', 'similar', '--similarity-threshold', '0.96', '--json'], { cwd: root, ...mock, markdown: revisedReport });
  assert.equal(result.status, 0, result.stderr);
  const [entry] = JSON.parse(result.stdout).comments;
  assert.equal(entry.action, 'skipped');
  assert.equal(entry.reason, 'similar');
  assert.ok(entry.similarity >= 0.96 && entry.similarity < 1);
  assert.equal(entry.url, duplicateUrl);
  assert.equal(result.stderr, '');
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('CLI threshold overrides a configured threshold and is applied to matching', async t => {
  const { root, sha } = await fixture(t);
  await writeFile(path.join(root, '.gh-comment.json'), JSON.stringify({ dedupe: 'similar', similarityThreshold: 0.96 }));
  const skipped = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--json'], {
    cwd: root, ...api(sha, { comments: [existingComment(reportText)] }), markdown: revisedReport,
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(JSON.parse(skipped.stdout).comments[0].action, 'skipped');
  const created = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--similarity-threshold', '1', '--json'], {
    cwd: root, ...api(sha, { comments: [existingComment(reportText)] }), markdown: revisedReport,
  });
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).comments[0].action, 'created');
});

test('an explicit config is shell-relative and flags override its dedupe mode', async t => {
  const { root, sha } = await fixture(t);
  const shell = path.join(root, 'reports');
  await mkdir(shell);
  await writeFile(path.join(shell, 'custom.json'), JSON.stringify({ dedupe: 'similar', similarityThreshold: 0.96 }));
  await writeFile(path.join(root, '.gh-comment.json'), JSON.stringify({ dedupe: 'off' }));
  const skipped = await invoke(['post', '-', '--cwd', root, '--repo', 'example/project', '--pr', '12', '--config', 'custom.json', '--json'], {
    cwd: shell, ...api(sha, { comments: [existingComment(reportText)] }), markdown: revisedReport,
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(JSON.parse(skipped.stdout).comments[0].action, 'skipped');
  const created = await invoke(['post', '-', '--cwd', root, '--repo', 'example/project', '--pr', '12', '--config', 'custom.json', '--dedupe', 'exact', '--json'], {
    cwd: shell, ...api(sha, { comments: [existingComment(reportText)] }), markdown: revisedReport,
  });
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).comments[0].action, 'created');
});

test('invalid configuration prevents even metadata API requests', async t => {
  const { root, sha } = await fixture(t);
  await writeFile(path.join(root, '.gh-comment.json'), JSON.stringify({ dedupe: 'similar', similarityThreshold: 96 }));
  const mock = api(sha);
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12'], { cwd: root, ...mock, markdown: 'Report' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /similarityThreshold/);
  assert.equal(mock.calls.length, 0);
});

test('post dry-run reports existing matches and pending batch duplicates without writes', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha, { comments: [existingComment('Report')] });
  const markdown = 'Report\n\n<!-- gh-comment:next -->\n\nAnother report\n\n<!-- gh-comment:next -->\n\nAnother report';
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--dry-run', '--json'], { cwd: root, ...mock, markdown });
  assert.equal(result.status, 0, result.stderr);
  const entries = JSON.parse(result.stdout).comments;
  assert.deepEqual(entries.map(entry => entry.action), ['skipped', 'created', 'skipped']);
  assert.equal(entries[0].url, duplicateUrl);
  assert.equal(entries[2].duplicateOf, 2);
  assert.equal(entries[2].url, undefined);
  assert.equal(entries[2].body, 'Another report');
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('human dry-run separates Markdown on stdout from explained decisions on stderr', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha, { comments: [existingComment('Report')] });
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--dry-run'], {
    cwd: root, ...mock, markdown: 'Report\n\n<!-- gh-comment:next -->\n\nAnother report',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Report\n/);
  assert.match(result.stderr, /Would skip comment 1 \(exact duplicate, 100% match\)/);
  assert.match(result.stderr, /Would create comment 2/);
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('publishing repeated entries returns one create and resolved duplicate URLs', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha);
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--json'], {
    cwd: root, ...mock, markdown: 'Report\n\n<!-- gh-comment:next -->\n\nReport',
  });
  assert.equal(result.status, 0, result.stderr);
  const [created, skipped] = JSON.parse(result.stdout).comments;
  assert.equal(created.action, 'created');
  assert.equal(skipped.action, 'skipped');
  assert.equal(skipped.url, created.url);
  assert.equal(skipped.duplicateOf, 1);
  assert.equal(mock.calls.filter(call => call.method === 'POST').length, 1);
});

test('dedupe off restores append behavior without identity or comment-list requests', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha, { comments: [existingComment('Report')] });
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--dedupe', 'off', '--json'], { cwd: root, ...mock, markdown: 'Report' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).comments[0].action, 'created');
  assert.ok(!mock.calls.some(call => call.path === '/user' || (call.method === 'GET' && call.path.endsWith('/comments'))));
});

test('render with PR metadata does not query duplicate detection or author identity', async t => {
  const { root, sha } = await fixture(t);
  const mock = api(sha, { comments: [existingComment('Report')] });
  const result = await invoke(['render', '-', '--repo', 'example/project', '--pr', '12', '--json'], { cwd: root, ...mock, markdown: 'Report' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).comments, [{ body: 'Report' }]);
  assert.deepEqual(mock.calls.map(call => call.path), ['/repos/example/project/pulls/12']);
});

test('dry-run can verify an app bot through a GraphQL query without publishing', async t => {
  const { root, sha } = await fixture(t);
  const calls = [];
  const github = new GitHub({ token: 'installation-test-token', fetch: async (url, init) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, method: init.method });
    if (pathname === '/repos/example/project/pulls/12') {
      return Response.json({ head: { sha, repo: { full_name: 'example/project' } } });
    }
    if (pathname === '/user') return Response.json({ message: 'Resource not accessible by integration' }, { status: 403 });
    if (pathname === '/graphql') {
      assert.equal(JSON.parse(init.body).query, 'query { viewer { login databaseId } }');
      return Response.json({ data: { viewer: { databaseId: 42, login: 'review[bot]' } } });
    }
    if (pathname === '/repos/example/project/issues/12/comments' && init.method === 'GET') {
      return Response.json([existingComment('Report')]);
    }
    throw new Error(`Unexpected write or request ${init.method} ${pathname}`);
  } });
  const result = await invoke(['post', '-', '--repo', 'example/project', '--pr', '12', '--dry-run', '--json'], { cwd: root, github, markdown: 'Report' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).comments[0].action, 'skipped');
  assert.deepEqual(calls.filter(call => call.method !== 'GET'), [{ pathname: '/graphql', method: 'POST' }]);
});

test('installed executable entry point runs with Node', async () => {
  const executable = path.resolve('bin/gh-comment.js');
  const { stdout } = await exec(process.execPath, [executable, '--help']);
  assert.match(stdout, /gh-comment render/);
  assert.equal((await readFile(executable, 'utf8')).split('\n')[0], '#!/usr/bin/env node');
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { main } from '../src/cli.js';

const SHA = 'a'.repeat(40);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const OTHER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Zf1sAAAAASUVORK5CYII=', 'base64');
const assetUrl = id => `https://github.com/user-attachments/assets/00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const prose = 'The current implementation correctly validates the input before creating a request and returns a useful explanation when the data cannot be processed. Please keep the validation close to the entry point so future callers can use the same behavior without adding their own checks or copying this logic elsewhere for maintainers.';
const image = '![Screenshot](media/screen.png "Review image")';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gh-comment-media-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'reports', 'media'), { recursive: true });
  const imageFile = path.join(root, 'reports', 'media', 'screen.png');
  const reportFile = path.join(root, 'reports', 'report.md');
  await writeFile(imageFile, PNG);
  await writeFile(reportFile, `Review screenshot.\n\n${image}\n`);
  const comments = [];
  const reviewComments = [];
  const uploads = [];
  const calls = [];
  const viewer = { id: 42, login: 'tester' };
  const github = {
    async getPull() { calls.push('getPull'); return { number: 12, head: { sha: SHA, ref: 'feature', repo: { full_name: 'example/project' } } }; },
    async getViewer() { calls.push('getViewer'); return viewer; },
    async listComments() { calls.push('listComments'); return comments.map(comment => ({ ...comment })); },
    async listReviewComments() { calls.push('listReviewComments'); return reviewComments.map(comment => ({ ...comment })); },
    async preflightAttachmentUpload(repo) { calls.push('preflight'); assert.equal(repo, 'example/project'); return { id: 321, permissions: { push: true } }; },
    async uploadAttachment(repo, asset) {
      calls.push('upload');
      assert.equal(repo, 'example/project');
      const body = asset.openBody();
      const chunks = [];
      if (Buffer.isBuffer(body)) chunks.push(body);
      else for await (const chunk of body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.length, asset.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
      const url = assetUrl(uploads.length + 1);
      uploads.push({ asset, bytes, url });
      return url;
    },
    async createComment(repo, pr, body) {
      calls.push('create');
      assert.equal(repo, 'example/project'); assert.equal(pr, 12);
      const id = comments.length + 100;
      const comment = { id, body, user: viewer, html_url: `https://github.com/example/project/pull/12#issuecomment-${id}` };
      comments.push(comment);
      return { ...comment };
    },
    async updateComment(repo, id, body) {
      calls.push('update');
      assert.equal(repo, 'example/project');
      const comment = comments.find(entry => entry.id === id);
      assert.ok(comment);
      comment.body = body;
      return { ...comment };
    },
  };
  async function invoke(extra = [], { file = 'reports/report.md', command = 'post', io = {} } = {}) {
    let stdout = '';
    let stderr = '';
    const args = [command, file, '--repo', 'example/project', '--json', ...(command === 'post' ? ['--pr', '12'] : []), ...extra];
    const status = await main(args, { cwd: root, env: {}, github, ...io,
      stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } },
    });
    return { status, stdout, stderr, result: status === 0 ? JSON.parse(stdout) : undefined };
  }
  return { root, imageFile, reportFile, comments, reviewComments, uploads, calls, github, invoke,
    writeReport: value => writeFile(reportFile, value), writes: () => calls.filter(call => ['upload', 'create', 'update'].includes(call)) };
}

function manifest(body) {
  const encoded = body.match(/<!-- gh-comment:attachments:([A-Za-z0-9_-]+) -->/)?.[1];
  assert.ok(encoded, 'Published comment should carry its attachment manifest');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

test('a real Markdown file uploads report-relative images and writes reusable hash metadata', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'media'));
  await writeFile(path.join(f.root, 'media', 'screen.png'), OTHER_PNG);
  const source = await readFile(f.reportFile, 'utf8');
  const output = await f.invoke();
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.result.comments[0].action, 'created');
  assert.equal(output.result.attachments[0].action, 'uploaded');
  assert.deepEqual(f.uploads[0].bytes, PNG);
  assert.match(f.comments[0].body, new RegExp(assetUrl(1)));
  assert.doesNotMatch(f.comments[0].body, /media\/screen\.png|gh-comment\.invalid/);
  assert.match(f.comments[0].body, /"Review image"/);
  assert.deepEqual(manifest(f.comments[0].body).assets, [{
    sha256: createHash('sha256').update(PNG).digest('hex'), contentType: 'image/png', url: assetUrl(1),
  }]);
  assert.equal(await readFile(f.reportFile, 'utf8'), source);
  assert.throws(() => f.uploads[0].asset.openBody(), /disposed/);
});

test('rerunning a report recognizes hashes and skips without more uploads or comments', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke()).status, 0);
  const repeated = await f.invoke();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.result.comments[0].action, 'skipped');
  assert.equal(repeated.result.comments[0].reason, 'exact');
  assert.equal(repeated.result.attachments[0].action, 'skipped');
  assert.equal(repeated.result.attachments[0].url, assetUrl(1));
  assert.equal(f.uploads.length, 1);
  assert.equal(f.comments.length, 1);
});

test('a conversation comment reuses an asset previously posted in a review thread', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke()).status, 0);
  f.reviewComments.push(f.comments.pop());
  await f.writeReport(`A different finding.\n\n${image}\n`);

  const output = await f.invoke();
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.result.comments[0].action, 'created');
  assert.equal(output.result.attachments[0].action, 'reused');
  assert.equal(f.uploads.length, 1);
  assert.match(f.comments[0].body, new RegExp(assetUrl(1)));
  assert.ok(f.calls.includes('listReviewComments'));
});

test('a different report and filename reuse the same uploaded bytes', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke()).status, 0);
  await writeFile(path.join(f.root, 'reports', 'media', 'copy.png'), PNG);
  await f.writeReport('Another finding.\n\n![Screenshot](media/copy.png)');
  const output = await f.invoke();
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.result.comments[0].action, 'created');
  assert.equal(output.result.attachments[0].action, 'reused');
  assert.equal(f.uploads.length, 1);
  assert.equal(f.comments.length, 2);
  assert.equal(manifest(f.comments[1].body).assets[0].url, assetUrl(1));
});

test('similar prose is skipped before uploading the unchanged attachment again', async t => {
  const f = await fixture(t);
  await f.writeReport(`${prose}\n\n${image}`);
  assert.equal((await f.invoke(['--dedupe', 'similar'])).status, 0);
  await f.writeReport(`${prose.replace('useful explanation', 'clear explanation')}\n\n${image}`);
  const output = await f.invoke(['--dedupe', 'similar']);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.result.comments[0].action, 'skipped');
  assert.equal(output.result.comments[0].reason, 'similar');
  assert.equal(output.result.attachments[0].action, 'skipped');
  assert.equal(f.uploads.length, 1);
  assert.equal(f.comments.length, 1);
});

test('a keyed image change uploads new bytes and updates the existing comment', async t => {
  const f = await fixture(t);
  const first = await f.invoke(['--key', 'review']);
  assert.equal(first.status, 0, first.stderr);
  await writeFile(f.imageFile, OTHER_PNG);
  const updated = await f.invoke(['--key', 'review', '--dedupe', 'similar']);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(updated.result.comments[0].action, 'updated');
  assert.equal(updated.result.comments[0].id, first.result.comments[0].id);
  assert.equal(updated.result.attachments[0].action, 'uploaded');
  assert.equal(f.uploads.length, 2);
  assert.equal(f.comments.length, 1);
  assert.equal(manifest(f.comments[0].body).assets[0].url, assetUrl(2));
  assert.ok(f.comments[0].body.endsWith('<!-- gh-comment:key:review -->'));
  const repeated = await f.invoke(['--key', 'review']);
  assert.equal(repeated.result.comments[0].action, 'unchanged');
  assert.equal(f.uploads.length, 2);
});

test('an unkeyed image-byte change creates a new comment despite identical prose', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke(['--dedupe', 'similar'])).status, 0);
  await writeFile(f.imageFile, OTHER_PNG);
  const output = await f.invoke(['--dedupe', 'similar']);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.result.comments[0].action, 'created');
  assert.equal(output.result.attachments[0].action, 'uploaded');
  assert.equal(f.uploads.length, 2);
  assert.equal(f.comments.length, 2);
});

test('dry-run reports planned upload or skip without asset or comment writes', async t => {
  const f = await fixture(t);
  const preview = await f.invoke(['--dry-run']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.result.comments[0].action, 'created');
  assert.equal(preview.result.attachments[0].action, 'upload');
  assert.equal(f.writes().length, 0);
  assert.equal((await f.invoke()).status, 0);
  const before = f.writes().length;
  const repeated = await f.invoke(['--dry-run']);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.result.comments[0].action, 'skipped');
  assert.equal(repeated.result.attachments[0].action, 'skip');
  assert.match(repeated.result.comments[0].body, new RegExp(assetUrl(1)));
  assert.equal(f.writes().length, before);
});

test('a missing attachment in a later entry prevents every upload and comment write', async t => {
  const f = await fixture(t);
  await f.writeReport(`${image}\n\n<!-- gh-comment:next -->\n\n![Missing](media/missing.png)`);
  const output = await f.invoke(['--attachment-memory-limit', '0.00000095367431640625']);
  assert.equal(output.status, 1);
  assert.match(output.stderr, /could not|cannot|missing|open/i);
  assert.equal(f.writes().length, 0);
});

test('the same attachment across comment entries uploads only once', async t => {
  const f = await fixture(t);
  await f.writeReport(`First finding.\n\n${image}\n\n<!-- gh-comment:next -->\n\nSecond finding.\n\n${image}`);
  const output = await f.invoke();
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(output.result.comments.map(comment => comment.action), ['created', 'created']);
  assert.equal(output.result.attachments.length, 1);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.comments.length, 2);
  assert.deepEqual(f.comments.map(comment => manifest(comment.body).assets[0].url), [assetUrl(1), assetUrl(1)]);
});

test('cross-entry reference images do not publish stale local definitions', async t => {
  const f = await fixture(t);
  await f.writeReport(`![Screenshot][shot]\n\n<!-- gh-comment:next -->\n\nSecond note.\n\n[shot]: ${f.imageFile}`);
  const output = await f.invoke();
  assert.equal(output.status, 0, output.stderr);
  assert.equal(f.uploads.length, 1);
  assert.match(f.comments[0].body, new RegExp(assetUrl(1)));
  assert.ok(f.comments.every(comment => !comment.body.includes(f.imageFile)), 'Converted local paths must not remain in another posted entry');
});

test('an attachment authorization failure makes no asset or comment writes', async t => {
  const f = await fixture(t);
  f.github.preflightAttachmentUpload = async () => { throw new Error('Attaching files requires write access'); };
  const output = await f.invoke();
  assert.equal(output.status, 1);
  assert.match(output.stderr, /requires write access/);
  assert.equal(f.writes().length, 0);
});

test('a failed later upload prevents all comment writes and disposes snapshots', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'reports', 'media', 'other.png'), OTHER_PNG);
  await f.writeReport(`${image}\n\n<!-- gh-comment:next -->\n\n![Other](media/other.png)`);
  const originalUpload = f.github.uploadAttachment;
  let attempts = 0;
  let failedAsset;
  f.github.uploadAttachment = async (repo, asset) => {
    attempts++;
    if (attempts === 2) { failedAsset = asset; throw new Error('Upload connection interrupted'); }
    return originalUpload(repo, asset);
  };
  const output = await f.invoke();
  assert.equal(output.status, 1);
  assert.match(output.stderr, /No comments were written/);
  assert.match(output.stderr, /may remain unattached/);
  assert.equal(attempts, 2);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.comments.length, 0);
  assert.throws(() => failedAsset.openBody(), /disposed/);
  assert.throws(() => f.uploads[0].asset.openBody(), /disposed/);
});

test('a PR head change during uploads prevents comment publication', async t => {
  const f = await fixture(t);
  const originalPull = f.github.getPull;
  let reads = 0;
  f.github.getPull = async () => {
    const pull = await originalPull();
    reads++;
    if (reads > 2) pull.head.sha = 'b'.repeat(40);
    return pull;
  };
  const output = await f.invoke();
  assert.equal(output.status, 1);
  assert.match(output.stderr, /head changed while uploading/);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.comments.length, 0);
});

test('upload uses an immutable snapshot even if the original file changes during preflight', async t => {
  const f = await fixture(t);
  const originalPreflight = f.github.preflightAttachmentUpload;
  f.github.preflightAttachmentUpload = async (...args) => {
    await writeFile(f.imageFile, OTHER_PNG);
    return originalPreflight(...args);
  };
  const output = await f.invoke(['--attachment-memory-limit', '0.00000095367431640625']);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.result.attachments[0].storage, 'disk');
  assert.deepEqual(f.uploads[0].bytes, PNG);
  assert.deepEqual(await readFile(f.imageFile), OTHER_PNG);
  assert.throws(() => f.uploads[0].asset.openBody(), /disposed/);
});

test('another author cannot populate this author\'s attachment reuse cache', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke()).status, 0);
  f.comments[0].user = { id: 99, login: 'other-person' };
  const output = await f.invoke();
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.result.comments[0].action, 'created');
  assert.equal(output.result.attachments[0].action, 'uploaded');
  assert.equal(f.uploads.length, 2);
  assert.equal(manifest(f.comments[1].body).assets[0].url, assetUrl(2));
});

test('--attach uses the shell directory while Markdown paths use the report directory', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'extra.png'), OTHER_PNG);
  const output = await f.invoke(['--attach', 'extra.png']);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(f.uploads.length, 2);
  assert.deepEqual(f.uploads.map(upload => upload.bytes), [PNG, OTHER_PNG]);
  assert.equal(manifest(f.comments[0].body).assets.length, 2);
});

test('--attachment-base resolves stdin images from the explicit shell-relative folder', async t => {
  const f = await fixture(t);
  const output = await f.invoke(['--attachment-base', 'reports/media'], {
    file: '-', io: { stdin: Readable.from(['A screenshot.\n\n![Screenshot](screen.png)']) },
  });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(f.uploads.length, 1);
  assert.deepEqual(f.uploads[0].bytes, PNG);
});

test('unknown local image types fail, while raw HTML and code examples remain untouched', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'reports', 'media', 'notes.txt'), 'not an image');
  await f.writeReport('![Unknown image](media/notes.txt)');
  const invalid = await f.invoke();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unsupported attachment type/);
  assert.equal(f.writes().length, 0);
  const literal = '<img src="missing.png">\n\n`![example](missing.png)`\n\n```markdown\n![example](missing.png)\n```';
  await f.writeReport(literal);
  const output = await f.invoke();
  assert.equal(output.status, 0, output.stderr);
  assert.equal(f.comments[0].body, literal);
  assert.equal(f.uploads.length, 0);
});

test('offline render with remote opt-in reports a pending download without network access', async t => {
  const f = await fixture(t);
  await f.writeReport('![Remote image](https://example.invalid/screenshot.png)');
  const output = await f.invoke(['--upload-remote-images'], { command: 'render', io: {
    repository: { resolveCommit: async () => SHA },
  } });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.result.attachments[0].action, 'download');
  assert.match(output.result.comments[0].body, /https:\/\/example\.invalid\/screenshot\.png/);
  assert.equal(f.calls.length, 0);
});

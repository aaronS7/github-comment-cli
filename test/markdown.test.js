import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Repository } from '../src/git.js';
import { MAX_COMMENT_LENGTH, renderMarkdown, SEPARATOR, validateBody } from '../src/markdown.js';

const URL = 'https://github.com/example/project/blob/0123456789012345678901234567890123456789/src/file.js#L2-L3';
const fixedResolver = async () => ({ url: URL });

test('replaces common inline link destinations while preserving labels, titles, and layout', async () => {
  const source = '# Review\n\n- [**Bold** and `code` [nested]](src/file.js:2-3 "Details")\n- [escaped\\] label](<src/my file.js#L2-L3> \'More\')\n- [empty label next]()\n';
  const seen = [];
  const comments = await renderMarkdown(source, async target => {
    seen.push(target);
    return { url: URL };
  });
  assert.deepEqual(seen, ['src/file.js:2-3', 'src/my file.js#L2-L3']);
  assert.deepEqual(comments, [{ body: `# Review\n\n- [**Bold** and \`code\` [nested]](${URL} "Details")\n- [escaped\\] label](<${URL}> 'More')\n- [empty label next]()` }]);
});

test('decodes Markdown escapes and entities before resolving destinations', async () => {
  const source = '[parentheses](src/file\\(copy\\).js:2) [entity](src/a&amp;b.js:3) [brackets](src/\\[copy\\].js:4)';
  const seen = [];
  await renderMarkdown(source, async target => { seen.push(target); return { url: URL }; });
  assert.deepEqual(seen, ['src/file(copy).js:2', 'src/a&b.js:3', 'src/[copy].js:4']);
});

test('preserves code examples, images, external URLs, headings, and links without line numbers', async () => {
  const source = '# Review\n\n`[inline](src/file.js:2)`\n\n```md\n[code](src/file.js:2)\n<!-- gh-comment:next -->\n```\n\n    [indented](src/file.js:2)\n\n![image](src/image.png:2)\n[web](https://example.com/src.js:2)\n[heading](#L2)\n[docs](docs/guide.md)\n[docs heading](docs/guide.md#heading)\n<https://example.com/file.js:2>\n\n![reference image][image]\n\n[image]: src/image.png:2';
  const comments = await renderMarkdown(source, async () => { assert.fail('Unexpected reference resolution'); });
  assert.deepEqual(comments, [{ body: source }]);
});

test('converts line-bearing autolinks without changing neighboring Markdown', async () => {
  assert.deepEqual(await renderMarkdown('Read <README.md:2> then [later](https://example.com).', fixedResolver), [
    { body: `Read <${URL}> then [later](https://example.com).` },
  ]);
});

test('preserves telephone and other non-file numeric URI destinations', async () => {
  const source = '[phone](tel:1234) [text](sms:1234) [http](http:80)';
  assert.deepEqual(await renderMarkdown(source, async () => { assert.fail('Unexpected URI resolution'); }), [{ body: source }]);
});

test('resolves full, collapsed, and shortcut reference links with a shared definition', async () => {
  const source = '[first][code] and [code][] and [code].\n\n[code]: src/file.js:2-3 "Source"';
  const comments = await renderMarkdown(source, fixedResolver);
  assert.deepEqual(comments, [{ body: `[first](<${URL}> "Source") and [code](<${URL}> "Source") and [code](<${URL}> "Source").\n\n[code]: ${URL} "Source"` }]);
});

test('makes reference links and images self-contained when splitting comment entries', async () => {
  const source = `[first][web]\n\n![a\\]b][image]\n\n${SEPARATOR}\n\nSecond [source][code].\n\n[web]: https://example.com/docs "Docs"\n[image]: https://example.com/image.png "Image"\n[code]: src/file.js:2-3`;
  assert.deepEqual(await renderMarkdown(source, fixedResolver), [
    { body: '[first](<https://example.com/docs> "Docs")\n\n![a\\]b](<https://example.com/image.png> "Image")' },
    { body: `Second [source](<${URL}>).\n\n[web]: https://example.com/docs "Docs"\n[image]: https://example.com/image.png "Image"\n[code]: ${URL}` },
  ]);
});

test('converted reference definitions do not retain absolute checkout paths', async () => {
  const [comment] = await renderMarkdown('[source][escaped\\]ref]\n\n[escaped\\]ref]: </home/example/src/my file.js:2> "Source"', fixedResolver);
  assert.ok(!comment.body.includes('/home/example'));
  assert.ok(comment.body.includes(`[escaped\\]ref]: <${URL}> "Source"`));
});

test('handles nested reference images without overlapping source replacements', async () => {
  const source = `[outer ![a\\]b][image]][code]\n\n${SEPARATOR}\n\nSecond.\n\n[code]: src/file.js:2-3\n[image]: https://example.com/img.png`;
  const comments = await renderMarkdown(source, fixedResolver);
  assert.equal(comments[0].body, `[outer ![a\\]b](<https://example.com/img.png>)](<${URL}>)`);
  assert.equal(comments.length, 2);
});

test('only standalone top-level separator comments split entries', async () => {
  const source = `First.\n${SEPARATOR}\nSecond.\n\n> ${SEPARATOR}\n\nInline ${SEPARATOR} stays.\n\n<!-- different -->`;
  assert.deepEqual(await renderMarkdown(source, fixedResolver), [
    { body: 'First.' },
    { body: `Second.\n\n> ${SEPARATOR}\n\nInline ${SEPARATOR} stays.\n\n<!-- different -->` },
  ]);
});

test('a leading thread directive sets placement without entering the comment body', async () => {
  const source = '<!-- gh-comment:thread path="src/file.js" line="12-13" side="RIGHT" -->\nCheck both lines.\n\n<!-- gh-comment:next -->\n\nA conversation note.';
  assert.deepEqual(await renderMarkdown(source, fixedResolver), [
    { kind: 'thread', path: 'src/file.js', startLine: 12, line: 13, side: 'RIGHT', body: 'Check both lines.' },
    { body: 'A conversation note.' },
  ]);
  await assert.rejects(renderMarkdown('Preface.\n\n<!-- gh-comment:thread path="src/file.js" line="12" side="RIGHT" -->\nCheck.', fixedResolver), /before the comment body/);
});

test('rejects invalid local line numbers with Markdown source location', async () => {
  for (const target of ['src/file.js:0', 'src/file.js:3-2', 'src/file.js#L0', 'src/file.js#L4-L2']) {
    await assert.rejects(renderMarkdown(`Heading\n\n[bad](${target})`, fixedResolver), /Markdown line 3: Invalid line range/);
  }
  await assert.rejects(renderMarkdown('First\n\n[bad](src/file.js:7)', async () => { throw new Error('Line 7 is outside file.'); }), /Markdown line 3: Line 7 is outside file/);
});

test('rejects empty, HTML-only, and definition-only entries', async () => {
  for (const body of ['', ' \n\t', '<!-- note -->', '[ref]: https://example.com', `First.\n\n${SEPARATOR}`, `${SEPARATOR}\n\nSecond.`, `First.\n\n${SEPARATOR}\n\n[ref]: https://example.com`]) {
    await assert.rejects(renderMarkdown(body, fixedResolver), /Comment \d+ is empty/, body);
  }
});

test('enforces comment length after rendering and accepts the exact boundary', async () => {
  validateBody('x'.repeat(MAX_COMMENT_LENGTH));
  validateBody('😀'.repeat(MAX_COMMENT_LENGTH));
  assert.throws(() => validateBody('x'.repeat(MAX_COMMENT_LENGTH + 1)), /exceeds GitHub/);
  const source = `${'x'.repeat(MAX_COMMENT_LENGTH - 30)} [source](src/file.js:2)`;
  await assert.rejects(renderMarkdown(source, fixedResolver), /exceeds GitHub/);
});

test('strips a leading BOM and preserves CRLF source layout', async () => {
  assert.deepEqual(await renderMarkdown('\uFEFF# Review\r\n\r\n[code](src/file.js:2)', fixedResolver), [
    { body: `# Review\r\n\r\n[code](${URL})` },
  ]);
});

test('integrates real Git snapshots, absolute paths, URL encoding, and dirty-line failures', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gh-comment-markdown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const git = async (...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '--quiet');
  await git('config', 'user.name', 'Test Author');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'commit.gpgSign', 'false');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/my (copy).js'), 'first\nsecond\nthird\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'Add source');
  const repository = await Repository.discover(root);
  const sha = await repository.head();
  const resolve = target => repository.resolveReference(target, { sha, repo: 'example/project' });
  const markdown = `[relative](<src/my (copy).js:2-3>)\n\n[absolute](<${root}/src/my (copy).js#L1>)`;
  const [comment] = await renderMarkdown(markdown, resolve);
  assert.equal(comment.body, `[relative](<https://github.com/example/project/blob/${sha}/src/my%20%28copy%29.js#L2-L3>)\n\n[absolute](<https://github.com/example/project/blob/${sha}/src/my%20%28copy%29.js#L1>)`);
  await writeFile(path.join(root, 'src/my (copy).js'), 'inserted\nfirst\nsecond\nthird\n');
  await assert.rejects(renderMarkdown(markdown, resolve), /Markdown line 1: Local file .* differs from/);
});

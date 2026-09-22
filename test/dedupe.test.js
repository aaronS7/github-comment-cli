import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareBodies, fingerprint } from '../src/dedupe.js';

const similar = (left, right, threshold = 0.96) => compareBodies(left, right, { mode: 'similar', threshold });
const prose = 'The service adapter retains the original request metadata while assembling the response payload and translating the upstream response into the expected output shape. This paragraph describes the behavior of the surrounding implementation in enough detail to compare minor wording adjustments while retaining the intended context for reviewers reading the generated report.';

test('exact matching normalizes CRLF, outer whitespace, and ordinary prose spaces', () => {
  const left = '\n\n# Review\r\n\r\nThe   adapter\tretains metadata.\r\n\r\n';
  const right = '# Review\n\nThe adapter retains metadata.';
  assert.deepEqual(compareBodies(left, right), { reason: 'exact', similarity: 1 });
  assert.equal(fingerprint(left).hash, fingerprint(right).hash);
  assert.equal(compareBodies('Case matters.', 'case matters.'), null);
  assert.equal(compareBodies('First.\nSecond.', 'First. Second.'), null);
});

test('exact matching retains Markdown structure, hard breaks, and prose case', () => {
  for (const [left, right] of [
    ['First.\n\nSecond.', 'First. Second.'],
    ['First.  \nSecond.', 'First.\nSecond.'],
    ['**Important** finding.', '*Important* finding.'],
    ['# Heading', '## Heading'],
    ['1. One\n2. Two', '2. One\n3. Two'],
  ]) assert.equal(compareBodies(left, right), null, `${left} versus ${right}`);
});

test('genuine trailing key markers are ignored, including different keys', () => {
  const plain = 'Review complete.';
  const first = `${plain}\n\n<!-- gh-comment:key:review -->\n`;
  const second = `${plain}\n\n<!-- gh-comment:key:another.key_2 -->`;
  assert.deepEqual(compareBodies(plain, first), { reason: 'exact', similarity: 1 });
  assert.deepEqual(compareBodies(first, second), { reason: 'exact', similarity: 1 });
});

test('marker code examples, inline markers, invalid keys, and arbitrary metadata remain meaningful', () => {
  const marker = '<!-- gh-comment:key:review -->';
  for (const body of [
    `Review complete.\n\n\`\`\`markdown\n${marker}\n\`\`\``,
    `Review complete.\n\n    ${marker}`,
    `Review complete. ${marker}`,
    `Review complete.\n\n> ${marker}`,
    'Review complete.\n\n<!-- gh-comment:key:invalid key -->',
    'Review complete.\n\n<!-- other-tool:key:review -->',
    'Review complete.\n\n<!-- report-metadata:123 -->',
    `${marker}\n\nReview complete.`,
    `Review complete.\n\n<!-- other metadata -->\n\n${marker}`,
  ]) assert.equal(compareBodies('Review complete.', body), null, body);
});

test('fuzzy matching is opt-in and uses cached fingerprints interchangeably', () => {
  const revised = prose.replace('surrounding', 'adjacent');
  assert.equal(compareBodies(prose, revised), null);
  const match = similar(prose, revised);
  assert.equal(match.reason, 'similar');
  assert.ok(match.similarity >= 0.96 && match.similarity < 1);
  assert.deepEqual(compareBodies(fingerprint(prose), fingerprint(revised), { mode: 'similar' }), match);
  assert.deepEqual(compareBodies(fingerprint(prose), revised, { mode: 'similar' }), match);
  assert.equal(similar(prose, revised, 0.999), null);
});

test('word-bigram Dice counts repeated pairs rather than just distinct words', () => {
  const match = similar('alpha beta alpha beta', 'alpha beta alpha beta alpha beta', 0.01);
  assert.deepEqual(match, { reason: 'similar', similarity: 0.75 });
  assert.equal(similar('alpha beta gamma delta', 'delta gamma beta alpha', 0.01), null);
  assert.deepEqual(similar('Word', 'word'), { reason: 'similar', similarity: 1 });
});

test('fuzzy matching preserves fenced and indented code, language, and inline-code whitespace/case', () => {
  for (const [left, right] of [
    ['```js\n  call();\n```', '```js\n call();\n```'],
    ['```js\ncall();\n```', '```js\nCALL();\n```'],
    ['```js\ncall();\n```', '```ts\ncall();\n```'],
    ['    call();', '    other();'],
    ['`a  b`', '`a b`'],
    ['`Call()`', '`call()`'],
  ]) {
    assert.equal(compareBodies(left, right), null);
    assert.equal(similar(`${prose}\n\n${left}`, `${prose}\n\n${right}`, 0.01), null, left);
  }
});

test('fuzzy matching preserves destinations, anchors, exact commits, and reference targets', () => {
  const prefix = 'https://github.com/example/project/blob/';
  for (const [left, right] of [
    [`[code](${prefix}${'a'.repeat(40)}/src/file.js#L12)`, `[code](${prefix}${'b'.repeat(40)}/src/file.js#L12)`],
    [`[code](${prefix}${'a'.repeat(40)}/src/file.js#L12)`, `[code](${prefix}${'a'.repeat(40)}/src/file.js#L13)`],
    ['[code](src/one.js:12)', '[code](src/two.js:12)'],
    ['[code][ref]\n\n[ref]: https://example.com/one', '[code][ref]\n\n[ref]: https://example.com/two'],
    ['![image](https://example.com/one.png)', '![image](https://example.com/two.png)'],
  ]) assert.equal(similar(`${prose}\n\n${left}`, `${prose}\n\n${right}`, 0.01), null, left);
});

test('fuzzy matching protects numbers, versions, SHAs, paths, and comparison punctuation in prose', () => {
  for (const [left, right] of [
    ['Timeout is 30 seconds.', 'Timeout is 60 seconds.'],
    ['Timeout is -30 seconds.', 'Timeout is 30 seconds.'],
    ['Version v1.2.3.', 'Version v1.2.4.'],
    ['Commit abcdefab.', 'Commit abcdefac.'],
    ['File src/one.js.', 'File src/two.js.'],
    ['File main.js.', 'File other.js.'],
    ['Edit Makefile.', 'Edit Dockerfile.'],
    ['Choose left < right.', 'Choose left > right.'],
    ['Review the adapter, then continue.', 'Review the adapter then continue.'],
  ]) assert.equal(similar(`${prose}\n\n${left}`, `${prose}\n\n${right}`, 0.01), null, left);
});

test('fuzzy matching guards negation, severity, modals, outcomes and critical-word neighborhoods', () => {
  for (const [left, right] of [
    ['Requests retry.', 'Requests do not retry.'],
    ['Requests can retry.', 'Requests cannot retry.'],
    ['Requests should retry.', 'Requests must retry.'],
    ['Requests are safe.', 'Requests are unsafe.'],
    ['Severity is high.', 'Severity is low.'],
    ['Checks passed.', 'Checks failed.'],
    ['The result is true.', 'The result is false.'],
    ['The payload is encrypted.', 'The payload is unencrypted.'],
    ["Requests don't retry.", 'Requests retry.'],
    ['Client does not retry while server retries.', 'Client retries while server does not retry.'],
  ]) assert.equal(similar(`${prose}\n\n${left}`, `${prose}\n\n${right}`, 0.01), null, left);
});

test('HTML folding markup, attributes, arbitrary HTML metadata and math/table structure are protected', () => {
  for (const [left, right] of [
    ['<details>\n<summary>One</summary>\n\nBody\n\n</details>', '<details>\n<summary>Two</summary>\n\nBody\n\n</details>'],
    ['<details>\n\nBody\n\n</details>', '<details open>\n\nBody\n\n</details>'],
    ['<!-- status: one -->', '<!-- status: two -->'],
    ['A | B\n--- | ---\nx | y', 'A | B --- | --- x | y'],
    ['$a  b$', '$a b$'],
    ['$$\na\nb\n$$', '$$\na b\n$$'],
  ]) {
    assert.equal(compareBodies(left, right), null);
    assert.equal(similar(`${prose}\n\n${left}`, `${prose}\n\n${right}`, 0.01), null, left);
  }
});

test('GFM checkbox state and alert type are protected even inside long reports', () => {
  for (const [left, right] of [
    ['- [ ] Implement feature', '- [x] Implement feature'],
    ['- [X] Implement feature', '- [ ] Implement feature'],
    ['> [!NOTE]\n> Context here.', '> [!TIP]\n> Context here.'],
  ]) {
    assert.equal(compareBodies(left, right), null);
    assert.equal(similar(`${prose}\n\n${left}`, `${prose}\n\n${right}`, 0.01), null);
  }
});

test('escaped, entity-encoded, and malformed GFM markers cannot normalize into active syntax', () => {
  for (const [left, right] of [
    ['- [ ] Implement feature', '- \\[ ] Implement feature'],
    ['- [ ] Implement feature', '- [  ] Implement feature'],
    ['- [x] Implement feature', '- [ x ] Implement feature'],
    ['- [ ] Implement feature', '- &#91; ] Implement feature'],
    ['> [!NOTE]\n> Context here.', '> \\[!NOTE]\n> Context here.'],
    ['> [!NOTE]\n> Context here.', '> &#91;!NOTE]\n> Context here.'],
  ]) {
    assert.equal(compareBodies(left, right), null, left);
    assert.equal(similar(`${prose}\n\n${left}`, `${prose}\n\n${right}`, 0.01), null, right);
  }
});

test('unchanged large code blocks cannot dilute a changed prose score', () => {
  const code = '\n\n```js\n' + 'const value = "same";\n'.repeat(2000) + '```';
  assert.equal(similar(`Cache request metadata.${code}`, `Rewrite response headers.${code}`), null);
});

test('handles near-limit comments without edit-distance matrices', () => {
  const left = ('adapter retains request metadata while assembling response payload. ').repeat(960);
  assert.ok(left.length < 65536 && left.length > 60000);
  const right = left.replace('assembling', 'preparing');
  const match = similar(left, right);
  assert.equal(match.reason, 'similar');
  assert.ok(match.similarity > 0.99);
});

test('validates the pure comparison API options and body types', () => {
  for (const threshold of [0, -1, 1.1, NaN, Infinity, '0.96']) {
    assert.throws(() => compareBodies('a', 'a', { threshold }), /Similarity threshold/);
  }
  assert.throws(() => compareBodies('a', 'a', { mode: 'guess' }), /mode must be exact or similar/);
  assert.throws(() => fingerprint(null), /body must be a string/);
  assert.equal(compareBodies('a', 'b'), null);
});

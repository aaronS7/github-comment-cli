import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentReferences, escapeLabel, rewriteAttachments } from '../src/attachment-markdown.js';
import {
  appendAttachmentMetadata, assetKey, assetPlaceholder, attachmentCache,
  comparisonBody, readAttachmentMetadata, validAssetUrl,
} from '../src/attachment-metadata.js';
import { compareBodies } from '../src/dedupe.js';

const FIRST = 'https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555';
const SECOND = 'https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ASSET = { sha256: 'a'.repeat(64), contentType: 'image/png', url: FIRST };
const marker = payload => `<!-- gh-comment:attachments:${Buffer.from(JSON.stringify(payload)).toString('base64url')} -->`;
const rewrite = (source, url = FIRST, video = false) => rewriteAttachments(source, attachmentReferences(source)
  .filter(reference => !reference.definitionOnly).map(reference => ({ reference, url, video })));

test('discovers inline and reference attachments while preserving code and raw HTML', () => {
  const source = '![inline](screen.png)\n\n![ref][image]\n\n[video](clip.mp4)\n\n`![code](code.png)`\n\n```md\n![fenced](fenced.png)\n```\n\n    ![indented](indented.png)\n\n<img src="raw.png">\n\n[image]: ref.png\n[unused]: orphan.png';
  const references = attachmentReferences(source);
  assert.deepEqual(references.filter(reference => !reference.definitionOnly).map(reference => reference.url), ['screen.png', 'ref.png', 'clip.mp4']);
  assert.deepEqual(references.filter(reference => reference.definitionOnly).map(reference => reference.url), ['ref.png', 'orphan.png']);
  const result = rewrite(source);
  assert.ok(result.includes('`![code](code.png)`'));
  assert.ok(result.includes('![fenced](fenced.png)'));
  assert.ok(result.includes('<img src="raw.png">'));
  assert.ok(result.endsWith('[unused]: orphan.png'));
});

test('rewrites destinations without altering escaped image alt text or link titles', () => {
  const source = '![a\\]b [nested]](<screen shot.png> "Caption")\n\n![a\\]b][image]\n\n[image]: <ref image.png> \'Reference title\'';
  assert.equal(rewrite(source), `![a\\]b [nested]](<${FIRST}> "Caption")\n\n![a\\]b][image]\n\n[image]: <${FIRST}> 'Reference title'`);
  assert.equal(escapeLabel('a\\[b]\nc\r'), 'a\\\\\\[b\\] c ');
});

test('handles nested images and brackets inside inline-code labels without overlapping edits', () => {
  for (const bracket of ['[', ']']) {
    const source = `[see \`${bracket}\` and ![image](screen.png)](other.png "Outer")`;
    assert.equal(rewrite(source), `[see \`${bracket}\` and ![image](${FIRST})](${FIRST} "Outer")`);
    const standalone = `![alt \`${bracket}\` text](screen.png)`;
    assert.equal(rewrite(standalone), `![alt \`${bracket}\` text](${FIRST})`);
  }
  const source = '[![a\\]b][image]][target]\n\n[image]: screen.png\n[target]: larger.png';
  assert.equal(rewrite(source), `[![a\\]b][image]][target]\n\n[image]: ${FIRST}\n[target]: ${FIRST}`);
});

test('standalone video images become bare URLs and inline video images become escaped links', () => {
  assert.equal(rewrite('![Clip](clip.mp4)', FIRST, true), FIRST);
  assert.equal(rewrite('Watch ![a\\]b](clip.mp4) for details.', FIRST, true), `Watch [a\\]b](${FIRST}) for details.`);
  assert.equal(rewrite('[Clip](clip.mp4)', FIRST, true), `[Clip](${FIRST})`);
  assert.equal(rewrite(`Before.\n\n${FIRST}\n\nAfter.`, SECOND, true), `Before.\n\n${SECOND}\n\nAfter.`);
});

test('video images nested anywhere inside another link are explicitly rejected', () => {
  for (const source of [
    '[![Clip](clip.mp4)](https://example.com)',
    '[**![Clip](clip.mp4)**](https://example.com)',
    '[*![Clip][clip]*][target]\n\n[clip]: clip.mp4\n[target]: https://example.com',
  ]) {
    const references = attachmentReferences(source).filter(reference => reference.image);
    assert.ok(references.every(reference => reference.insideLink));
    assert.throws(() => rewriteAttachments(source, references.map(reference => ({ reference, url: FIRST, video: true }))), /video attachment cannot be nested/);
  }
});

test('reference-video conversion rewrites orphan definitions again when finalizing uploaded URLs', () => {
  const asset = { ...ASSET, contentType: 'video/mp4' };
  const placeholder = assetPlaceholder(asset);
  const source = '![Clip][clip]\n\n[clip]: clips/local.mp4 "Recording"';
  const intermediate = rewrite(source, placeholder, true);
  assert.equal(intermediate, `${placeholder}\n\n[clip]: ${placeholder} "Recording"`);
  assert.deepEqual(attachmentReferences(intermediate).map(reference => reference.definitionOnly), [false, true]);
  const finalized = rewriteAttachments(intermediate, attachmentReferences(intermediate).map(reference => ({ reference, url: FIRST })));
  assert.equal(finalized, `${FIRST}\n\n[clip]: ${FIRST} "Recording"`);
  assert.ok(!finalized.includes('gh-comment.invalid'));
});

test('only strict canonical GitHub asset URLs are recognized', () => {
  assert.equal(validAssetUrl(FIRST), true);
  assert.equal(validAssetUrl(SECOND), true);
  for (const value of [
    FIRST.toUpperCase(), FIRST.replace('/assets/', '/ASSETS/'), `${FIRST}/`, `${FIRST}?token=x`, `${FIRST}#fragment`,
    FIRST.replace('github.com', 'github.com.evil.invalid'), FIRST.replace('https:', 'http:'),
    FIRST.replace('github.com/', 'user:secret@github.com/'), FIRST.replace('11111111-', 'not-a-uuid-'), null,
  ]) assert.equal(validAssetUrl(value), false, String(value));
});

test('valid trailing metadata round-trips and stays immediately before an existing key', () => {
  const original = `![Screenshot](${FIRST})`;
  const plain = appendAttachmentMetadata(original, [ASSET]);
  assert.deepEqual(readAttachmentMetadata(plain), { body: original, assets: [ASSET] });
  const keyed = `${original}\n\n<!-- gh-comment:key:report -->`;
  const withMetadata = appendAttachmentMetadata(keyed, [ASSET]);
  assert.ok(withMetadata.endsWith('<!-- gh-comment:key:report -->'));
  assert.deepEqual(readAttachmentMetadata(withMetadata), { body: keyed, assets: [ASSET] });
  assert.equal(appendAttachmentMetadata(original, []), original);
  assert.throws(() => appendAttachmentMetadata('Unclosed\n\n```md\nexample', [ASSET]), /open Markdown block/);
});

test('metadata in code, blockquotes, inline prose, or nontrailing positions remains untouched', () => {
  const tag = marker({ v: 1, assets: [ASSET] });
  const image = `![Screenshot](${FIRST})`;
  for (const original of [
    `${image}\n\n\`\`\`md\n${tag}\n\`\`\``,
    `${image}\n\n    ${tag}`,
    `${image}\n\n> ${tag}`,
    `${image} ${tag}`,
    `${image}\n\n${tag}\n\nLater paragraph.`,
    `${image}\n\n<div>\n${tag}\n</div>`,
  ]) assert.deepEqual(readAttachmentMetadata(original), { body: original, assets: [] });
});

test('unused definitions, code examples, and raw HTML cannot establish cached attachment metadata', () => {
  for (const content of [
    `[unused]: ${FIRST}`,
    `Example: \`${FIRST}\``,
    `\`\`\`md\n![Screenshot](${FIRST})\n\`\`\``,
    `<img src="${FIRST}">`,
    `![Other](${SECOND})`,
  ]) {
    const original = `${content}\n\n${marker({ v: 1, assets: [ASSET] })}`;
    assert.deepEqual(readAttachmentMetadata(original), { body: original, assets: [] });
    assert.equal(attachmentCache([{ body: original }]).size, 0);
  }
  for (const content of [`[Attachment](${FIRST})`, FIRST, `![Screenshot][ref]\n\n[ref]: ${FIRST}`]) {
    assert.equal(readAttachmentMetadata(appendAttachmentMetadata(content, [ASSET])).assets.length, 1);
  }
});

test('malformed attachment metadata is never stripped or trusted for cache reuse', () => {
  const invalid = [
    { v: 2, assets: [ASSET] }, { v: 1, assets: [] }, { v: 1, assets: [ASSET], extra: true },
    { v: 1, assets: [{ ...ASSET, sha256: ['a'.repeat(64)] }] },
    { v: 1, assets: [{ ...ASSET, contentType: ['image/png'] }] },
    { v: 1, assets: [{ ...ASSET, sha256: 'A'.repeat(64) }] },
    { v: 1, assets: [{ ...ASSET, sha256: 'a'.repeat(63) }] },
    { v: 1, assets: [{ ...ASSET, contentType: 'text/html' }] },
    { v: 1, assets: [{ ...ASSET, url: `${FIRST}?token=secret` }] },
    { v: 1, assets: [{ ...ASSET, extra: true }] },
    { v: 1, assets: [ASSET, ASSET] },
    { v: 1, assets: [ASSET, { ...ASSET, url: SECOND }] },
    { v: 1, assets: [ASSET, { ...ASSET, sha256: 'b'.repeat(64) }] },
  ];
  for (const payload of invalid) {
    const original = `![One](${FIRST})\n\n![Two](${SECOND})\n\n${marker(payload)}`;
    assert.deepEqual(readAttachmentMetadata(original), { body: original, assets: [] }, JSON.stringify(payload));
    assert.equal(comparisonBody(original), original);
  }
});

test('noncanonical base64 encodings remain ordinary meaningful HTML comments', () => {
  const asset = { ...ASSET, contentType: 'image/jpeg' };
  const canonical = Buffer.from(JSON.stringify({ v: 1, assets: [asset] })).toString('base64url');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const altered = canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.at(-1)) + 1];
  assert.deepEqual(Buffer.from(altered, 'base64url'), Buffer.from(canonical, 'base64url'));
  const original = `![Image](${FIRST})\n\n<!-- gh-comment:attachments:${altered} -->`;
  assert.deepEqual(readAttachmentMetadata(original), { body: original, assets: [] });
});

test('hash cache and comparison canonicalization reuse bytes across distinct uploaded URLs', () => {
  const other = { ...ASSET, url: SECOND };
  const first = appendAttachmentMetadata(`![Screenshot](${FIRST})`, [ASSET]);
  const second = appendAttachmentMetadata(`![Screenshot](${SECOND})`, [other]);
  assert.equal(comparisonBody(first), `![Screenshot](${assetPlaceholder(ASSET)})`);
  assert.equal(comparisonBody(first), comparisonBody(second));
  assert.deepEqual(compareBodies(first, second), { reason: 'exact', similarity: 1 });
  const cache = attachmentCache([{ body: first }, { body: second }]);
  assert.equal(cache.size, 1);
  assert.deepEqual(cache.get(assetKey(ASSET)), ASSET);
  assert.equal(comparisonBody(`[Link](${FIRST})`, cache), `[Link](${assetPlaceholder(ASSET)})`);
});

test('comparison preserves changed bytes, MIME, alt text and surrounding content', () => {
  const original = appendAttachmentMetadata(`Same prose.\n\n![Screenshot](${FIRST})`, [ASSET]);
  const variants = [
    appendAttachmentMetadata(`Same prose.\n\n![Screenshot](${FIRST})`, [{ ...ASSET, sha256: 'b'.repeat(64) }]),
    appendAttachmentMetadata(`Same prose.\n\n![Screenshot](${FIRST})`, [{ ...ASSET, contentType: 'image/jpeg' }]),
    appendAttachmentMetadata(`Same prose.\n\n![Edited description](${FIRST})`, [ASSET]),
    appendAttachmentMetadata(`Completely different prose.\n\n![Screenshot](${FIRST})`, [ASSET]),
  ];
  for (const changed of variants) assert.equal(compareBodies(original, changed), null);
  for (const changed of variants.slice(0, 3)) assert.equal(compareBodies(original, changed, { mode: 'similar', threshold: 0.01 }), null);
});

test('canonicalizing a video also rewrites its now-unused reference definition', () => {
  const firstAsset = { ...ASSET, contentType: 'video/mp4' };
  const secondAsset = { ...firstAsset, url: SECOND };
  const first = appendAttachmentMetadata(`${FIRST}\n\n[video]: ${FIRST}`, [firstAsset]);
  const second = appendAttachmentMetadata(`${SECOND}\n\n[video]: ${SECOND}`, [secondAsset]);
  assert.equal(comparisonBody(first), `${assetPlaceholder(firstAsset)}\n\n[video]: ${assetPlaceholder(firstAsset)}`);
  assert.deepEqual(compareBodies(first, second), { reason: 'exact', similarity: 1 });
});

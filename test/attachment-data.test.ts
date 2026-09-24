import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { AttachmentDataError, isPublicAddress, prepareAttachment, type AttachmentDataOptions } from '../src/attachment-data.js';
import type { PreparedAttachment } from '../src/attachment-types.js';

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('image fixture bytes')]);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const remote: AttachmentDataOptions = { downloadRemote: true, allowPrivateNetwork: true };

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gh-comment-attachment-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tempRoot = path.join(root, 'snapshots');
  await mkdir(tempRoot);
  return { root, tempRoot };
}

async function server(t: TestContext, handler: http.RequestListener) {
  const listener = http.createServer(handler);
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { listener.closeAllConnections(); listener.close(resolve); }));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Expected the test server to have a TCP address.');
  return { base: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function body(prepared: PreparedAttachment): Promise<Buffer> {
  const value = prepared.openBody();
  if (Buffer.isBuffer(value)) return value;
  const chunks: Buffer[] = [];
  for await (const chunk of value) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function mockResponse(stream: Readable, statusCode: number, headers: IncomingHttpHeaders): IncomingMessage {
  return Object.assign(stream, { statusCode, headers }) as unknown as IncomingMessage;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof AttachmentDataError && error.code === code;
}

test('snapshots small local files in memory and hashes the immutable prepared bytes', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'screen.PNG'), PNG);
  const prepared = await prepareAttachment('screen.PNG', { baseDir: root });
  t.after(() => prepared.dispose());
  assert.equal(prepared.name, 'screen.PNG');
  assert.equal(prepared.contentType, 'image/png');
  assert.equal(prepared.size, PNG.length);
  assert.equal(prepared.sha256, digest(PNG));
  assert.equal(prepared.storage, 'memory');
  await writeFile(path.join(root, 'screen.PNG'), 'changed');
  const first = await body(prepared);
  first.fill(0);
  assert.deepEqual(await body(prepared), PNG);
  await prepared.dispose();
  await prepared.dispose();
  assert.throws(() => prepared.openBody(), { code: 'DISPOSED' });
});

test('spills into private disk snapshots, supports file URLs, and removes snapshots on disposal', async t => {
  const { root, tempRoot } = await fixture(t);
  const filename = path.join(root, 'screen.png');
  await writeFile(filename, PNG);
  const prepared = await prepareAttachment(pathToFileURL(filename).href, { memoryLimitBytes: 8, tempRoot });
  t.after(() => prepared.dispose());
  assert.equal(prepared.storage, 'disk');
  const stream = prepared.openBody();
  assert.ok(!Buffer.isBuffer(stream));
  const snapshotPath = stream.path.toString();
  stream.destroy();
  if (process.platform !== 'win32') {
    assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(snapshotPath))).mode & 0o777, 0o700);
  }
  await rm(filename);
  assert.deepEqual(await body(prepared), PNG);
  assert.equal(prepared.sha256, digest(PNG));
  await prepared.dispose();
  assert.deepEqual(await readdir(tempRoot), []);
});

test('zero memory allowance forces disk and disposal handles an unread open stream', async t => {
  const { root, tempRoot } = await fixture(t);
  await writeFile(path.join(root, 'screen.png'), PNG);
  const prepared = await prepareAttachment('screen.png', { baseDir: root, memoryLimitBytes: 0, tempRoot });
  assert.equal(prepared.storage, 'disk');
  const stream = prepared.openBody();
  assert.ok(!Buffer.isBuffer(stream));
  await prepared.dispose();
  assert.equal(stream.destroyed, true);
  assert.deepEqual(await readdir(tempRoot), []);
});

test('rejects empty, unsupported, missing, directory, and symlink local sources', async t => {
  const { root, tempRoot } = await fixture(t);
  await writeFile(path.join(root, 'empty.png'), '');
  await writeFile(path.join(root, 'note.pdf'), 'document');
  await mkdir(path.join(root, 'directory.png'));
  await writeFile(path.join(root, 'screen.png'), PNG);
  await symlink(path.join(root, 'screen.png'), path.join(root, 'linked.png'));
  for (const [name, code] of [
    ['empty.png', 'EMPTY_FILE'], ['note.pdf', 'UNSUPPORTED_TYPE'], ['missing.png', 'FILE_READ_FAILED'],
    ['directory.png', 'NOT_REGULAR_FILE'], ['linked.png', 'FILE_READ_FAILED'],
  ]) await assert.rejects(prepareAttachment(name, { baseDir: root, tempRoot }), { code }, name);
  assert.deepEqual(await readdir(tempRoot), []);
});

test('enforces inclusive media limits and cannot raise official limits through maxBytes', async t => {
  const { root, tempRoot } = await fixture(t);
  const image = path.join(root, 'large.png');
  const video = path.join(root, 'large.mp4');
  await writeFile(image, PNG);
  const exact = await prepareAttachment(image, { maxBytes: PNG.length });
  await exact.dispose();
  await assert.rejects(prepareAttachment(image, { maxBytes: PNG.length - 1 }), { code: 'TOO_LARGE' });
  await truncate(image, 10 * 1024 * 1024 + 1);
  await writeFile(video, 'video');
  await truncate(video, 100 * 1024 * 1024 + 1);
  await assert.rejects(prepareAttachment(image, { maxBytes: 1024 ** 3, tempRoot }), { code: 'TOO_LARGE' });
  await assert.rejects(prepareAttachment(video, { maxBytes: 1024 ** 3, tempRoot }), { code: 'TOO_LARGE' });
  assert.deepEqual(await readdir(tempRoot), []);
});

test('remote downloads require explicit permission and reject private literal addresses by default', async () => {
  await assert.rejects(prepareAttachment('https://example.com/image.png?token=secret'), { code: 'REMOTE_DISABLED' });
  for (const host of ['127.0.0.1', '127.1', '2130706433', '0x7f000001', '10.0.0.1', '169.254.169.254', '[::1]', '[::ffff:127.0.0.1]', '[fe80::1]']) {
    await assert.rejects(prepareAttachment(`http://${host}/image.png`, { downloadRemote: true }), { code: 'PRIVATE_NETWORK' }, host);
  }
});

test('public-address classification covers IPv4, IPv6, mapped and reserved ranges', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  for (const address of ['0.0.0.0', '100.64.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1', 'not-an-ip']) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test('rejects DNS names with any private answer before opening a connection', async () => {
  let requests = 0;
  await assert.rejects(prepareAttachment('http://fixture.invalid/image.png', {
    downloadRemote: true,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    requestImpl: async () => { requests += 1; throw new Error('Unexpected connection attempt'); },
  }), { code: 'PRIVATE_NETWORK' });
  assert.equal(requests, 0);
});

test('pins the checked DNS address and never sends environment credentials or cookies', async t => {
  let headers: IncomingHttpHeaders | undefined;
  const { port } = await server(t, (req, res) => {
    headers = req.headers;
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG);
  });
  let lookups = 0;
  const prepared = await prepareAttachment(`http://fixture.invalid:${port}/image.png?private=query`, {
    ...remote,
    lookup: async () => { lookups += 1; return [{ address: '127.0.0.1', family: 4 }]; },
    headers: { Authorization: 'should-be-ignored', Cookie: 'should-be-ignored' },
  } as AttachmentDataOptions);
  t.after(() => prepared.dispose());
  assert.equal(lookups, 1);
  assert.ok(headers);
  assert.equal(headers.host, `fixture.invalid:${port}`);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, undefined);
  assert.deepEqual(await body(prepared), PNG);
});

test('downloads extensionless media using the response type and sanitizes its name', async t => {
  const { base } = await server(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png; charset=binary' });
    res.end(PNG);
  });
  const prepared = await prepareAttachment(`${base}/download?token=secret`, remote);
  t.after(() => prepared.dispose());
  assert.equal(prepared.name, 'download.png');
  assert.equal(prepared.contentType, 'image/png');
  assert.equal(prepared.sha256, digest(PNG));
});

test('supports SVG and generic binary responses only when remote media bytes match', async t => {
  const svg = Buffer.from('<?xml version="1.0"?>\n<!-- generated -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const { base } = await server(t, (req, res) => {
    const requestPath = req.url ?? '';
    res.writeHead(200, { 'Content-Type': requestPath.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream' });
    res.end(requestPath.endsWith('.svg') ? svg : PNG);
  });
  for (const [name, expected] of [['image.svg', svg], ['image.png', PNG]]) {
    const prepared = await prepareAttachment(`${base}/${name}`, remote);
    assert.deepEqual(await body(prepared), expected);
    await prepared.dispose();
  }
});

test('redirects are bounded, cookies are not forwarded, and private redirect targets are rechecked', async t => {
  const requests: IncomingHttpHeaders[] = [];
  const { base } = await server(t, (req, res) => {
    requests.push(req.headers);
    if (req.url === '/start.png') {
      res.writeHead(302, { Location: '/end.png', 'Set-Cookie': 'secret=value' }); res.end();
    } else if (req.url === '/loop.png') { res.writeHead(302, { Location: '/loop.png' }); res.end(); }
    else { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); }
  });
  const prepared = await prepareAttachment(`${base}/start.png`, remote);
  await prepared.dispose();
  assert.equal(requests.length, 2);
  assert.ok(requests.every(headers => headers.cookie === undefined && headers.authorization === undefined));
  await assert.rejects(prepareAttachment(`${base}/loop.png`, { ...remote, maxRedirects: 1 }), { code: 'TOO_MANY_REDIRECTS' });
  let hops = 0;
  await assert.rejects(prepareAttachment('http://public.invalid/start.png', {
    downloadRemote: true,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: async () => {
      hops += 1;
      return mockResponse(Readable.from([]), 302, { location: 'http://127.0.0.1/private.png' });
    },
  }), { code: 'PRIVATE_NETWORK' });
  assert.equal(hops, 1);
});

test('rejects URL credentials and does not expose query strings in failed downloads', async t => {
  await assert.rejects(prepareAttachment('https://user:password@example.com/image.png?token=secret', remote), error => hasCode(error, 'URL_CREDENTIALS') && error instanceof Error && !/password|secret/.test(error.message));
  const { base } = await server(t, (_req, res) => { res.writeHead(403); res.end('secret server body'); });
  await assert.rejects(prepareAttachment(`${base}/image.png?token=secret`, remote), error => hasCode(error, 'HTTP_ERROR') && error instanceof Error && !/secret|token=/.test(error.message));
});

test('rejects HTML MIME and disguised HTML bytes, and cleans disk snapshots on rejection', async t => {
  const { tempRoot } = await fixture(t);
  const { base } = await server(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': req.url === '/html.png' ? 'text/html' : 'image/png' });
    res.end('<html>sign in instead</html>');
  });
  await assert.rejects(prepareAttachment(`${base}/html.png`, { ...remote, tempRoot }), { code: 'CONTENT_TYPE_MISMATCH' });
  await assert.rejects(prepareAttachment(`${base}/fake.png`, { ...remote, tempRoot, memoryLimitBytes: 1 }), { code: 'INVALID_MEDIA' });
  assert.deepEqual(await readdir(tempRoot), []);
});

test('enforces declared and streaming byte limits, including spill cleanup', async t => {
  const { tempRoot } = await fixture(t);
  const { base } = await server(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png', ...(req.url === '/declared.png' ? { 'Content-Length': '9999' } : {}) });
    res.write(PNG);
    setTimeout(() => res.end(Buffer.alloc(128)), 10);
  });
  for (const file of ['declared.png', 'chunked.png']) {
    await assert.rejects(prepareAttachment(`${base}/${file}`, { ...remote, maxBytes: 64, memoryLimitBytes: 1, tempRoot }), { code: 'TOO_LARGE' });
    assert.deepEqual(await readdir(tempRoot), []);
  }
});

test('decompresses gzip, deflate, and Brotli while limiting decoded bytes', async t => {
  const { tempRoot } = await fixture(t);
  const encoders = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
  const { base } = await server(t, (req, res) => {
    const [encodingValue, kind] = (req.url ?? '').slice(1).split('/');
    const encoding = encodingValue as keyof typeof encoders;
    const bytes = kind === 'large.png' ? Buffer.concat([PNG, Buffer.alloc(1024)]) : PNG;
    const compressed = encoders[encoding](bytes);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Encoding': encoding });
    res.end(compressed);
  });
  for (const encoding of Object.keys(encoders) as Array<keyof typeof encoders>) {
    const prepared = await prepareAttachment(`${base}/${encoding}/small.png`, { ...remote, tempRoot });
    assert.deepEqual(await body(prepared), PNG);
    await prepared.dispose();
    await assert.rejects(prepareAttachment(`${base}/${encoding}/large.png`, { ...remote, tempRoot, memoryLimitBytes: 1, maxBytes: 100 }), { code: 'TOO_LARGE' });
    assert.deepEqual(await readdir(tempRoot), []);
  }
});

test('deadlines cover slow responses and DNS, with no incomplete temp files', async t => {
  const { tempRoot } = await fixture(t);
  const { base } = await server(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.write(PNG); });
  await assert.rejects(prepareAttachment(`${base}/slow.png?token=secret`, { ...remote, timeoutMs: 30, memoryLimitBytes: 1, tempRoot }), { code: 'TIMEOUT' });
  assert.deepEqual(await readdir(tempRoot), []);
  await assert.rejects(prepareAttachment('https://slow.invalid/image.png', {
    downloadRemote: true, timeoutMs: 20, lookup: () => new Promise(() => {}),
  }), { code: 'TIMEOUT' });
});

test('rejects lying body lengths and cleans a completed disk snapshot on protocol failure', async t => {
  const { tempRoot } = await fixture(t);
  await assert.rejects(prepareAttachment('http://public.invalid/image.png', {
    downloadRemote: true, memoryLimitBytes: 1, tempRoot,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: async () => mockResponse(Readable.from([PNG]), 200, {
      'content-type': 'image/png', 'content-length': String(PNG.length - 1),
    }),
  }), { code: 'INCOMPLETE_DOWNLOAD' });
  assert.deepEqual(await readdir(tempRoot), []);
});

test('cleans a completed disk snapshot when the upstream pipeline fails on close', async t => {
  const { tempRoot } = await fixture(t);
  await assert.rejects(prepareAttachment('http://public.invalid/image.png', {
    downloadRemote: true, memoryLimitBytes: 1, tempRoot,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: async () => mockResponse(new Readable({
      read() { this.push(PNG); this.push(null); },
      destroy(_error, callback) { setTimeout(() => callback(new Error('late close failure')), 20); },
    }), 200, { 'content-type': 'image/png' }),
  }), { code: 'DOWNLOAD_FAILED' });
  assert.deepEqual(await readdir(tempRoot), []);
});

test('validates options and rejects unknown extension or extensionless unknown MIME', async t => {
  const invalidOptions: unknown[] = [{ memoryLimitBytes: -1 }, { maxBytes: 0 }, { timeoutMs: 0 }, { maxRedirects: -1 }, { downloadRemote: 'false' }, { allowPrivateNetwork: 'false' }];
  for (const options of invalidOptions) {
    await assert.rejects(prepareAttachment('image.png', options as AttachmentDataOptions), { code: 'INVALID_OPTION' });
  }
  const { base } = await server(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(PNG); });
  await assert.rejects(prepareAttachment(`${base}/download`, remote), { code: 'UNSUPPORTED_TYPE' });
  await assert.rejects(prepareAttachment(`${base}/document.pdf`, remote), { code: 'UNSUPPORTED_TYPE' });
});

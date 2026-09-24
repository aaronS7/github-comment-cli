import assert from 'node:assert/strict';
import { createReadStream, ReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { GitHub, GitHubError } from '../src/github.js';

type UploadAsset = Parameters<GitHub['uploadAttachment']>[1];
interface RecordedRequest {
  url: URL;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  redirect?: RequestRedirect;
  duplex?: string;
}
interface FixtureOptions {
  token?: string;
  repository?: unknown;
  upload?: (request: RecordedRequest) => Promise<Response>;
  apiUrl?: string;
}

const TOKEN = 'ghp_test_secret';
const ASSET_URL = 'https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc';
const REPOSITORY = { id: 321, full_name: 'owner/project', permissions: { push: true } };

function fixture({ token = TOKEN, repository = REPOSITORY, upload, apiUrl }: FixtureOptions = {}) {
  const requests: RecordedRequest[] = [];
  const github = new GitHub({ token, apiUrl, fetch: async (url, init) => {
    const request: RecordedRequest = {
      url: new URL(url instanceof Request ? url.url : url),
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body,
      signal: init?.signal ?? undefined,
      redirect: init?.redirect,
      duplex: (init as RequestInit & { duplex?: string } | undefined)?.duplex,
    };
    requests.push(request);
    if (init?.method === 'GET') return Response.json(repository);
    return upload ? upload(request) : Response.json({ url: ASSET_URL }, { status: 201 });
  } });
  return { github, requests, uploads: () => requests.filter(request => request.method === 'POST') };
}

function asset(overrides: Partial<UploadAsset> = {}): UploadAsset {
  const bytes = Buffer.from('test attachment bytes');
  return { name: 'screen shot.png', contentType: 'image/png', size: bytes.length, openBody: () => bytes, ...overrides } as UploadAsset;
}

async function fileAsset(t: TestContext, overrides: Partial<UploadAsset> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gh-comment-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('streamed attachment bytes');
  const filename = path.join(directory, 'recording.webm');
  await writeFile(filename, bytes);
  let stream: ReadStream | undefined;
  return { bytes, filename, stream: () => stream, asset: asset({ name: 'recording.webm', contentType: 'video/webm', size: bytes.length,
    openBody: () => (stream = createReadStream(filename)), ...overrides }) };
}

test('attachment preflight verifies and caches immutable repository authorization', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([
    f.github.preflightAttachmentUpload('owner/project'),
    f.github.preflightAttachmentUpload('OWNER/PROJECT'),
  ]);
  assert.equal(first, second);
  assert.equal(first.id, 321);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.href, 'https://api.github.com/repos/owner/project');
  assert.throws(() => { first.id = 999; });
  const permissions = first.permissions;
  assert.ok(permissions && typeof permissions === 'object');
  assert.throws(() => { (permissions as { push: boolean }).push = false; });
});

test('OAuth, classic PAT, and fine-grained PAT tokens can upload', async () => {
  for (const token of ['gho_oauth_token', 'ghp_personal_token', 'github_pat_fine_grained_token']) {
    const f = fixture({ token });
    assert.equal(await f.github.uploadAttachment('owner/project', asset()), ASSET_URL);
    assert.equal(f.uploads().length, 1);
    assert.equal(f.uploads()[0]?.headers?.Authorization, `Bearer ${token}`);
  }
});

test('missing and unsupported credentials fail before opening a file or fetching', async () => {
  for (const token of ['', 'ghs_actions_token', 'ghu_app_user_token', 'ghr_refresh_token', 'unknown_token', 'ghp_']) {
    let opened = false;
    const f = fixture({ token });
    await assert.rejects(f.github.uploadAttachment('owner/project', asset({ openBody: () => { opened = true; return Buffer.from(''); } })),
      /OAuth|personal access token/);
    assert.equal(opened, false);
    assert.equal(f.requests.length, 0);
  }
});

test('native uploads cannot send credentials to configurable or enterprise hosts', async () => {
  for (const apiUrl of ['https://api.example.test', 'https://github.example/api/v3', 'http://127.0.0.1:3000', 'https://api.github.com/extra']) {
    const f = fixture({ apiUrl });
    await assert.rejects(f.github.uploadAttachment('owner/project', asset()), /github.com only/);
    assert.equal(f.requests.length, 0);
  }
});

test('repository write access and positive ID are required before opening the attachment', async () => {
  for (const repository of [
    { id: 321, permissions: { push: false } }, { id: 321 },
    { id: 321, permissions: { admin: true } }, { id: 0, permissions: { push: true } },
  ]) {
    let opened = false;
    const f = fixture({ repository });
    await assert.rejects(f.github.uploadAttachment('owner/project', asset({ openBody: () => { opened = true; } })), /write access|repository ID/);
    assert.equal(opened, false);
    assert.equal(f.uploads().length, 0);
  }
});

test('failed preflight is not cached and its transport diagnostics expose no secrets', async () => {
  let attempts = 0;
  const github = new GitHub({ token: TOKEN, fetch: async () => {
    attempts++;
    if (attempts === 1) throw new Error(`Authorization ${TOKEN} at https://storage.example/file?signature=secret-query`);
    return Response.json(REPOSITORY);
  } });
  await assert.rejects(github.preflightAttachmentUpload('owner/project'), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Could not authorize/);
    assert.doesNotMatch(error.message, /ghp_test_secret|signature|secret-query/);
    return true;
  });
  assert.equal((await github.preflightAttachmentUpload('owner/project')).id, 321);
  assert.equal(attempts, 2);
});

test('buffer upload uses the fixed native endpoint and exact raw request headers', async () => {
  const payload = asset({ name: 'review #1?.png' });
  const f = fixture({ upload: async request => {
    assert.ok(request.headers);
    assert.equal(request.url.origin, 'https://uploads.github.com');
    assert.equal(request.url.pathname, '/user-attachments/assets');
    assert.deepEqual(Object.fromEntries(request.url.searchParams), {
      name: 'review #1?.png', content_type: 'image/png', repository_id: '321',
    });
    assert.equal(request.headers['Content-Type'], 'application/octet-stream');
    assert.equal(request.headers['Content-Length'], String(payload.size));
    assert.equal(request.headers.Accept, 'application/vnd.github+json');
    assert.equal(request.redirect, 'error');
    assert.deepEqual(request.body, payload.openBody());
    assert.ok(request.signal instanceof AbortSignal);
    return Response.json({ url: ASSET_URL }, { status: 201 });
  } });
  assert.equal(await f.github.uploadAttachment('owner/project', payload), ASSET_URL);
  assert.equal(f.uploads().length, 1);
});

test('file streams upload with duplex support and close before returning', async t => {
  const file = await fileAsset(t);
  const f = fixture({ upload: async request => {
    assert.ok(request.body instanceof ReadStream);
    assert.equal(request.duplex, 'half');
    const chunks = [];
    for await (const chunk of request.body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), file.bytes);
    return Response.json({ url: ASSET_URL });
  } });
  assert.equal(await f.github.uploadAttachment('owner/project', file.asset), ASSET_URL);
  const stream = file.stream();
  assert.ok(stream);
  assert.equal(stream.closed, true);
  assert.equal(stream.destroyed, true);
});

test('an early successful response still closes an unread file stream', async t => {
  const file = await fileAsset(t);
  const f = fixture();
  await f.github.uploadAttachment('owner/project', file.asset);
  assert.ok(file.stream()?.closed);
});

test('a file stream with autoClose disabled is explicitly closed after upload', async t => {
  const file = await fileAsset(t);
  const stream = createReadStream(file.filename, { autoClose: false });
  const f = fixture();
  await f.github.uploadAttachment('owner/project', { ...file.asset, openBody: () => stream });
  assert.equal(stream.closed, true);
});

test('a rejected attachment URL closes the unread input stream', async t => {
  const file = await fileAsset(t);
  const f = fixture({ upload: async () => Response.json({ url: 'https://attacker.test/file' }) });
  await assert.rejects(f.github.uploadAttachment('owner/project', file.asset), /invalid attachment URL/);
  assert.ok(file.stream()?.closed);
});

test('ambiguous upload failures close streams, redact secrets, and never retry', async t => {
  const file = await fileAsset(t);
  const f = fixture({ upload: async () => { throw new Error(`Failed ${TOKEN} https://storage.example/file?signature=secret-query`); } });
  await assert.rejects(f.github.uploadAttachment('owner/project', file.asset), error => {
    assert.ok(error instanceof GitHubError);
    assert.ok(error instanceof Error);
    assert.match(error.message, /may have uploaded/);
    assert.doesNotMatch(error.message, /ghp_test_secret|signature|secret-query/);
    return true;
  });
  const stream = file.stream();
  assert.ok(stream);
  assert.equal(stream.closed, true);
  assert.equal(f.uploads().length, 1);
});

test('a response-body failure closes the source stream and keeps the outcome ambiguous', async t => {
  const file = await fileAsset(t);
  const f = fixture({ upload: async () => ({ text: async () => { throw new Error('signed-private-response'); } } as unknown as Response) });
  await assert.rejects(f.github.uploadAttachment('owner/project', file.asset), /may have uploaded/);
  const stream = file.stream();
  assert.ok(stream);
  assert.equal(stream.closed, true);
  assert.equal(f.uploads().length, 1);
});

test('HTTP upload failures use safe diagnostics and no mutation retries', async () => {
  for (const status of [401, 403, 404, 413, 422, 429, 503]) {
    const f = fixture({ upload: async () => Response.json({ message: `${TOKEN} https://storage.example/file?signature=secret-query` }, { status }) });
    await assert.rejects(f.github.uploadAttachment('owner/project', asset()), error => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /ghp_test_secret|signature|secret-query/);
      if (status === 503) assert.match(error.message, /may have uploaded/);
      return true;
    });
    assert.equal(f.uploads().length, 1);
  }
});

test('upload redirects are refused without following the Location URL', async () => {
  const f = fixture({ upload: async request => {
    assert.equal(request.redirect, 'error');
    return new Response('', { status: 307, headers: { Location: 'https://attacker.test/?signature=secret' } });
  } });
  await assert.rejects(f.github.uploadAttachment('owner/project', asset()), /redirects are refused/);
  assert.equal(f.uploads().length, 1);
  assert.ok(f.requests.every(request => ['https://api.github.com', 'https://uploads.github.com'].includes(request.url.origin)));
});

test('returned asset URLs must be HTTPS github.com native assets without credentials or signed queries', async () => {
  for (const value of [
    undefined, '', 'https://attacker.test/user-attachments/assets/id', 'https://github.com.attacker.test/user-attachments/assets/id',
    'http://github.com/user-attachments/assets/id', 'https://secret@github.com/user-attachments/assets/id',
    `${ASSET_URL}?signature=secret-query`, `${ASSET_URL}#fragment`, 'https://github.com/owner/project/blob/main/image.png',
    'https://github.com/user-attachments/assets/', 'https://github.com/user-attachments/assets/id/extra',
  ]) {
    const f = fixture({ upload: async () => Response.json({ url: value }) });
    await assert.rejects(f.github.uploadAttachment('owner/project', asset()), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid attachment URL/);
      assert.match(error.message, /may have uploaded/);
      assert.doesNotMatch(error.message, /secret|attacker/);
      return true;
    });
    assert.equal(f.uploads().length, 1);
  }
});

test('malformed successful upload JSON is ambiguous and does not expose its body', async () => {
  const f = fixture({ upload: async () => new Response(`private signed data ${TOKEN}`, { status: 201 }) });
  await assert.rejects(f.github.uploadAttachment('owner/project', asset()), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /invalid attachment URL/);
    assert.doesNotMatch(error.message, /private signed|ghp_test_secret/);
    return true;
  });
});

test('invalid metadata and changed buffer sizes fail without uploads', async () => {
  for (const value of [asset({ name: '../file.png' }), asset({ name: 'file\n.png' }), asset({ size: 0 }),
    asset({ contentType: 'image/png\r\nInjected: true' }), asset({ openBody: undefined } as unknown as Partial<UploadAsset>)]) {
    const f = fixture();
    await assert.rejects(f.github.uploadAttachment('owner/project', value), /requires a filename/);
    assert.equal(f.requests.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.github.uploadAttachment('owner/project', asset({ size: 100 })), /size changed/);
  assert.equal(f.uploads().length, 0);
});

test('file-open errors are sanitized and happen before the upload request', async () => {
  const f = fixture();
  await assert.rejects(f.github.uploadAttachment('owner/project', asset({ openBody: () => { throw new Error(`${TOKEN} secret-query`); } })), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Could not open/);
    assert.doesNotMatch(error.message, /ghp_test_secret|secret-query/);
    return true;
  });
  assert.equal(f.uploads().length, 0);
});

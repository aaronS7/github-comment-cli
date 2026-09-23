import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planPublication, publish } from '../src/publish.js';
import { appendAttachmentMetadata, assetKey } from '../src/attachment-metadata.js';

const SHA = 'a'.repeat(40);
const VIEWER = { id: 42, login: 'reviewer' };
const commentUrl = id => `https://github.com/example/project/pull/12#issuecomment-${id}`;

function fixture({ comments = [], reviewComments = [], bodies = ['Report'], settings, marker, overrides = {} } = {}) {
  const remote = comments.map(comment => ({ ...comment }));
  const remoteReview = reviewComments.map(comment => ({ ...comment }));
  const calls = [];
  let nextId = 1000;
  const github = {
    apiUrl: 'https://api.github.com',
    authenticated: true,
    async getViewer() { calls.push({ method: 'getViewer' }); return VIEWER; },
    async listComments(repo, pr) { calls.push({ method: 'listComments', repo, pr }); return remote.map(comment => ({ ...comment })); },
    async listReviewComments(repo, pr) { calls.push({ method: 'listReviewComments', repo, pr }); return remoteReview.map(comment => ({ ...comment })); },
    async getPull(repo, pr) { calls.push({ method: 'getPull', repo, pr }); return { number: pr, head: { sha: SHA } }; },
    async createComment(repo, pr, body) {
      calls.push({ method: 'createComment', repo, pr, body });
      const comment = own(body, nextId++);
      remote.push(comment);
      return { ...comment };
    },
    async updateComment(repo, id, body) {
      calls.push({ method: 'updateComment', repo, id, body });
      const existing = remote.find(comment => comment.id === id);
      assert.ok(existing, 'Must update an existing comment');
      existing.body = body;
      return { ...existing };
    },
    ...overrides,
  };
  const plan = { repo: 'example/project', pr: 12, sha: SHA, context: { github },
    comments: bodies.map(body => ({ body })), marker,
    settings: { dedupe: 'exact', similarityThreshold: 0.96, ...settings },
  };
  return { plan, github, remote, calls, writes: () => calls.filter(call => ['createComment', 'updateComment'].includes(call.method)) };
}

function thread(body, line = 12) {
  return { kind: 'thread', path: 'src/file.js', side: 'RIGHT', startLine: line, line, body };
}

function ownReview(body, line = 12, id = 200) {
  return { ...own(body, id), path: 'src/file.js', side: 'RIGHT', start_line: line, line, position: 1 };
}

function own(body, id = 100) {
  return { id, body, user: VIEWER, html_url: commentUrl(id) };
}

test('exact duplicate planning reports the existing comment without writes', async () => {
  const f = fixture({ comments: [own('Report')], bodies: ['Report'] });
  const result = await planPublication(f.plan);
  assert.equal(result.comments[0].body, 'Report');
  assert.equal(result.comments[0].action, 'skipped');
  assert.equal(result.comments[0].reason, 'exact');
  assert.equal(result.comments[0].id, 100);
  assert.equal(result.comments[0].url, commentUrl(100));
  assert.equal(f.writes().length, 0);
});

test('review duplicates require the same file, side, and line range', async () => {
  const f = fixture({ reviewComments: [ownReview('Check this line')], bodies: [] });
  f.plan.comments = [thread('Check this line'), thread('Check this line', 13)];
  const result = await planPublication(f.plan);
  assert.deepEqual(result.comments.map(entry => entry.action), ['skipped', 'created']);
  assert.equal(result.comments[0].id, 200);
  assert.deepEqual(f.calls.filter(call => call.method.startsWith('list')).map(call => call.method), ['listReviewComments']);
});

test('active attachments load both comment types even for a single kind of entry', async () => {
  const url = 'https://github.com/user-attachments/assets/00000000-0000-4000-8000-000000000001';
  const asset = { sha256: 'a'.repeat(64), contentType: 'image/png', url };
  const storedBody = appendAttachmentMetadata(`![Screenshot](${url})`, [asset]);
  for (const [entries, comments, reviewComments] of [
    [[{ body: 'Another report' }], [], [ownReview(storedBody)]],
    [[thread('Another report')], [own(storedBody)], []],
  ]) {
    const f = fixture({ comments, reviewComments, bodies: [], settings: { dedupe: 'off' } });
    f.plan.comments = entries;
    let cache;
    f.plan.attachments = {
      active: true,
      setCache(value) { cache = value; },
      validate() {},
      hasUploads() { return false; },
      describe() { return []; },
    };
    await planPublication(f.plan);
    assert.deepEqual(cache.get(assetKey(asset)), asset);
    assert.deepEqual(f.calls.filter(call => call.method.startsWith('list')).map(call => call.method),
      ['listComments', 'listReviewComments']);
  }
});

test('rerunning a successful append skips the persisted comment', async () => {
  const f = fixture();
  const first = await publish(f.plan);
  const second = await publish(f.plan);
  assert.equal(first.comments[0].action, 'created');
  assert.equal(second.comments[0].action, 'skipped');
  assert.equal(second.comments[0].reason, 'exact');
  assert.equal(second.comments[0].url, first.comments[0].url);
  assert.equal(second.comments[0].id, first.comments[0].id);
  assert.equal('body' in second.comments[0], false);
  assert.equal(f.writes().length, 1);
});

test('exact mode normalizes CRLF and surrounding blank space while retaining hard breaks', async () => {
  const f = fixture({ comments: [own('\nReport\r\n\r\nNext\r\n')], bodies: ['Report\n\nNext'] });
  assert.equal((await publish(f.plan)).comments[0].action, 'skipped');
  assert.equal(f.writes().length, 0);
  const meaningful = fixture({ comments: [own('Line\nNext')], bodies: ['Line  \nNext'] });
  assert.equal((await publish(meaningful.plan)).comments[0].action, 'created');
});

test('identical comments by other authors do not suppress this author', async () => {
  const f = fixture({ comments: [{ ...own('Report'), user: { id: 99, login: 'someone-else' } }] });
  assert.equal((await publish(f.plan)).comments[0].action, 'created');
  assert.equal(f.writes().length, 1);
});

test('unkeyed append can skip existing same-author keyed content without modifying it', async () => {
  const f = fixture({ comments: [own('Report\n\n<!-- gh-comment:key:summary -->')] });
  const result = await publish(f.plan);
  assert.equal(result.comments[0].action, 'skipped');
  assert.equal(result.comments[0].url, commentUrl(100));
  assert.equal(f.writes().length, 0);
});

test('same-file exact duplicates create once and report the same resulting URL', async () => {
  const f = fixture({ bodies: ['Report', 'Report', 'Different report', 'Report'] });
  const preview = await planPublication(f.plan);
  assert.deepEqual(preview.comments.map(comment => comment.action), ['created', 'skipped', 'created', 'skipped']);
  assert.equal(preview.comments[1].duplicateOf, 1);
  assert.equal(preview.comments[3].duplicateOf, 1);
  assert.equal(f.writes().length, 0);
  const result = await publish(f.plan);
  assert.equal(f.writes().length, 2);
  assert.equal(result.comments[1].url, result.comments[0].url);
  assert.equal(result.comments[3].id, result.comments[0].id);
  assert.equal(result.comments[1].duplicateOf, 1);
});

test('same-file entries that duplicate an existing comment all report its URL', async () => {
  const f = fixture({ bodies: ['Report', 'Report'], comments: [own('Report')] });
  const result = await publish(f.plan);
  assert.deepEqual(result.comments.map(comment => comment.action), ['skipped', 'skipped']);
  assert.deepEqual(result.comments.map(comment => comment.url), [commentUrl(100), commentUrl(100)]);
  assert.equal(f.writes().length, 0);
});

test('dedupe off creates all entries even if identical content already exists', async () => {
  const f = fixture({ bodies: ['Report', 'Report'], comments: [own('Report')], settings: { dedupe: 'off' },
    overrides: { getViewer: async () => { throw new Error('No identity lookup expected'); }, listComments: async () => { throw new Error('No comment listing expected'); } } });
  assert.deepEqual((await publish(f.plan)).comments.map(comment => comment.action), ['created', 'created']);
  assert.equal(f.writes().length, 2);
});

const prose = 'The current implementation correctly validates the input before creating a request and returns a useful explanation when the data cannot be processed. Please keep the validation close to the entry point so future callers can use the same behavior without adding their own checks or copying this logic elsewhere for maintainers.';
const similarProse = prose.replace('useful explanation', 'clear explanation');

test('similar mode reports high-confidence prose matches with a score and URL', async () => {
  const f = fixture({ comments: [own(prose)], bodies: [similarProse], settings: { dedupe: 'similar' } });
  const result = await publish(f.plan);
  assert.equal(result.comments[0].action, 'skipped');
  assert.equal(result.comments[0].reason, 'similar');
  assert.equal(result.comments[0].similarity, 0.96);
  assert.equal(result.comments[0].url, commentUrl(100));
  assert.equal(f.writes().length, 0);
});

test('similarity just below the configured threshold creates a comment', async () => {
  const f = fixture({ comments: [own(prose)], bodies: [similarProse], settings: { dedupe: 'similar', similarityThreshold: 0.960001 } });
  assert.equal((await publish(f.plan)).comments[0].action, 'created');
  assert.equal(f.writes().length, 1);
});

test('exact mode does not silently apply fuzzy matching', async () => {
  const f = fixture({ comments: [own(prose)], bodies: [similarProse] });
  assert.equal((await publish(f.plan)).comments[0].action, 'created');
});

test('exact candidates take precedence over earlier similar candidates', async () => {
  const f = fixture({ comments: [own(prose, 100), own(similarProse, 101)], bodies: [similarProse], settings: { dedupe: 'similar' } });
  const result = await publish(f.plan);
  assert.equal(result.comments[0].reason, 'exact');
  assert.equal(result.comments[0].id, 101);
});

const chainA = 'The service adapter retains the original request metadata while assembling the response payload and translating the upstream response into the expected output shape. This paragraph describes the behavior of the surrounding implementation in enough detail to compare minor wording adjustments while retaining the intended context for reviewers reading the generated report.';
const chainB = chainA.replace('surrounding', 'adjacent');
const chainC = chainB.replace('upstream', 'remote');

test('skipped fuzzy proposals never become candidates for later entries', async () => {
  // A~B and B~C score .96, but A~C scores only .92.
  const fromExisting = fixture({ comments: [own(chainA)], bodies: [chainB, chainC], settings: { dedupe: 'similar' } });
  const existingResult = await publish(fromExisting.plan);
  assert.deepEqual(existingResult.comments.map(comment => comment.action), ['skipped', 'created']);
  assert.equal(existingResult.comments[0].similarity, 0.96);
  assert.equal(fromExisting.writes().length, 1);
  const fromPending = fixture({ bodies: [chainA, chainB, chainC], settings: { dedupe: 'similar' } });
  const pendingResult = await publish(fromPending.plan);
  assert.deepEqual(pendingResult.comments.map(comment => comment.action), ['created', 'skipped', 'created']);
  assert.equal(pendingResult.comments[1].duplicateOf, 1);
  assert.equal(fromPending.writes().length, 2);
});

test('fuzzy selection chooses the highest score with deterministic first-match ties', async () => {
  const f = fixture({ comments: [own(chainC, 100), own(chainB, 101), own(chainB, 102)], bodies: [chainA],
    settings: { dedupe: 'similar', similarityThreshold: 0.9 } });
  const result = await publish(f.plan);
  assert.equal(result.comments[0].id, 101);
  assert.equal(result.comments[0].similarity, 0.96);
  assert.equal(f.writes().length, 0);
});

test('similar mode preserves substantive numeric and code changes', async () => {
  for (const [before, after] of [
    [`${prose}\n\nThe timeout is 30 seconds.`, `${prose}\n\nThe timeout is 60 seconds.`],
    [`${prose}\n\nUse \`result.ok\`.`, `${prose}\n\nUse \`result.error\`.`],
    [`${prose}\n\n[Code](https://github.com/example/project/blob/${SHA}/src/a.js#L10)`, `${prose}\n\n[Code](https://github.com/example/project/blob/${SHA}/src/a.js#L20)`],
  ]) {
    const f = fixture({ comments: [own(before)], bodies: [after], settings: { dedupe: 'similar' } });
    assert.equal((await publish(f.plan)).comments[0].action, 'created');
  }
});

test('keyed changes update the owned key even when similar mode would skip the body', async () => {
  const marker = '<!-- gh-comment:key:report -->';
  const f = fixture({ marker, comments: [own(`${prose}\n\n${marker}`)], bodies: [`${similarProse}\n\n${marker}`], settings: { dedupe: 'similar' } });
  const result = await publish(f.plan);
  assert.equal(result.comments[0].action, 'updated');
  assert.equal(f.writes().length, 1);
  assert.equal(f.writes()[0].method, 'updateComment');
  assert.equal(f.writes()[0].id, 100);
});

test('a new key creates a separate comment rather than matching unrelated body content', async () => {
  const marker = '<!-- gh-comment:key:report -->';
  const f = fixture({ marker, comments: [own('Report')], bodies: [`Report\n\n${marker}`] });
  assert.equal((await publish(f.plan)).comments[0].action, 'created');
  assert.equal(f.writes().length, 1);
});

test('normalized identical keyed content is unchanged even with dedupe off', async () => {
  const marker = '<!-- gh-comment:key:report -->';
  const f = fixture({ marker, comments: [own(`Report\r\n\r\n${marker}\r\n`)], bodies: [`Report\n\n${marker}`], settings: { dedupe: 'off' } });
  const result = await publish(f.plan);
  assert.equal(result.comments[0].action, 'unchanged');
  assert.equal(result.comments[0].url, commentUrl(100));
  assert.equal(f.writes().length, 0);
});

test('failure to verify author or list comments prevents every write', async () => {
  for (const method of ['getViewer', 'listComments']) {
    const f = fixture({ overrides: { [method]: async () => { throw new Error(`${method} denied`); } } });
    await assert.rejects(publish(f.plan), new RegExp(`${method} denied`));
    assert.equal(f.writes().length, 0);
  }
});

test('a malformed selected existing comment fails before any other entry is posted', async () => {
  const f = fixture({ comments: [{ ...own('Report'), html_url: undefined }], bodies: ['Different report', 'Report'] });
  await assert.rejects(publish(f.plan));
  assert.equal(f.writes().length, 0);
});

test('head movement is rechecked before writes after duplicate planning', async () => {
  const f = fixture({ overrides: { getPull: async () => ({ head: { sha: 'b'.repeat(40) } }) } });
  await assert.rejects(publish(f.plan), /head changed/i);
  assert.equal(f.writes().length, 0);
});

test('all-skipped reports make no writes and do not depend on a fresh head read', async () => {
  const f = fixture({ comments: [own('Report')], overrides: { getPull: async () => { throw new Error('No head read expected without writes'); } } });
  assert.equal((await publish(f.plan)).comments[0].action, 'skipped');
  assert.equal(f.writes().length, 0);
});

test('retry after an ambiguous accepted write finds and skips the actual remote comment', async () => {
  const f = fixture();
  const originalCreate = f.github.createComment;
  let attempts = 0;
  f.github.createComment = async (...args) => {
    attempts++;
    await originalCreate(...args);
    throw new Error('GitHub HTTP 503. The request may have reached GitHub; check the PR before retrying.');
  };
  await assert.rejects(publish(f.plan), /may have reached GitHub/);
  assert.equal(attempts, 1);
  f.github.createComment = originalCreate;
  const result = await publish(f.plan);
  assert.equal(result.comments[0].action, 'skipped');
  assert.equal(f.remote.length, 1);
  assert.equal(f.writes().length, 1);
});

test('partial failure reports skipped and written entries separately and a rerun resumes safely', async () => {
  const f = fixture({ comments: [own('Already')], bodies: ['Already', 'New', 'Failure', 'Later'] });
  const originalCreate = f.github.createComment;
  let attempts = 0;
  f.github.createComment = async (...args) => {
    attempts++;
    if (args[2] === 'Failure') throw new Error('Permission denied');
    return originalCreate(...args);
  };
  await assert.rejects(publish(f.plan), error => {
    assert.match(error.message, /Comment 3/);
    assert.match(error.message, /Published 1 of 4/);
    assert.deepEqual(error.partialResult.comments.map(comment => comment.action), ['skipped', 'created']);
    assert.equal(error.partialResult.comments[0].url, commentUrl(100));
    assert.equal(error.partialResult.comments[1].url, commentUrl(1000));
    return true;
  });
  assert.equal(attempts, 2);
  f.github.createComment = originalCreate;
  const result = await publish(f.plan);
  assert.deepEqual(result.comments.map(comment => comment.action), ['skipped', 'skipped', 'created', 'created']);
  assert.equal(f.remote.length, 4);
});

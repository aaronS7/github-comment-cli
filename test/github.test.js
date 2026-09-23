import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHub, GitHubError, parseRepo, parsePullRequest, resolveContext, resolveToken } from '../src/github.js';

const sha = 'a'.repeat(40);
const pull = { number: 42, head: { sha, ref: 'feature', repo: { full_name: 'contributor/project' } }, base: { sha: 'b'.repeat(40), ref: 'main' } };
const noRun = async () => { throw new Error('Command unavailable'); };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

test('parseRepo supports normal GitHub remote formats and validates host', () => {
  for (const input of ['owner/project', 'https://github.com/owner/project.git', 'git@github.com:owner/project.git', 'ssh://git@github.com/owner/project.git']) {
    assert.equal(parseRepo(input), 'owner/project');
  }
  for (const input of ['owner', 'owner/../other', 'https://elsewhere.test/owner/project', 'https://secret@github.com/owner/project', 'http://github.com/owner/project']) {
    assert.throws(() => parseRepo(input));
  }
});

test('PR parser supports URLs and rejects invalid numbers and hosts', () => {
  assert.deepEqual(parsePullRequest('42'), { number: 42 });
  assert.deepEqual(parsePullRequest('https://github.com/owner/project/pull/42/files#diff-example'), { number: 42, repo: 'owner/project' });
  for (const input of ['0', '-4', '1.5', '9007199254740992', 'https://elsewhere.test/owner/project/pull/42', 'https://github.com/owner/project/issues/42']) {
    assert.throws(() => parsePullRequest(input));
  }
});

test('authentication prioritizes env tokens and otherwise invokes gh without a shell', async () => {
  assert.equal(await resolveToken({ env: { GH_TOKEN: 'first', GITHUB_TOKEN: 'second' }, run: noRun }), 'first');
  assert.equal(await resolveToken({ env: { GITHUB_TOKEN: 'second' }, run: noRun }), 'second');
  assert.equal(await resolveToken({ env: {}, run: async (command, args) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.com']);
    return ' token-from-gh\n';
  } }), 'token-from-gh');
  assert.equal(await resolveToken({ env: {}, run: noRun }), undefined);
});

test('timeline publication sends exact Markdown JSON with authentication', async () => {
  let calls = 0;
  const github = new GitHub({ token: 'test-token', fetch: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.github.com/repos/owner/project/issues/42/comments');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { body: '# Comment\n\n`$()` stays literal.' });
    return json({ id: 7, html_url: 'https://github.com/owner/project/pull/42#issuecomment-7' }, 201);
  } });
  assert.equal((await github.createComment('owner/project', 42, '# Comment\n\n`$()` stays literal.')).id, 7);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(github).includes('test-token'), false);
});

test('new PR review operations send the documented endpoint fields', async () => {
  const seen = [];
  const github = new GitHub({ token: 'test-token', fetch: async (url, options) => {
    seen.push({ path: new URL(url).pathname, method: options.method, body: options.body && JSON.parse(options.body) });
    return json(options.method === 'GET' ? [] : { id: 88, html_url: 'https://github.com/owner/project/pull/42#discussion_r88' }, options.method === 'GET' ? 200 : 201);
  } });
  await github.createFileComment('owner/project', 42, { path: 'src/file.js' }, 'Whole file.', sha);
  await github.createReviewReply('owner/project', 42, 77, 'Follow-up.');
  await github.createReview('owner/project', 42, { commit_id: sha, body: 'Summary.', event: 'COMMENT', comments: [{ path: 'src/file.js', line: 2, side: 'RIGHT', body: 'Line.' }] });
  await github.listReviews('owner/project', 42);
  await github.listReviewCommentsForReview('owner/project', 42, 88);
  assert.deepEqual(seen, [
    { path: '/repos/owner/project/pulls/42/comments', method: 'POST', body: { body: 'Whole file.', commit_id: sha, path: 'src/file.js', subject_type: 'file' } },
    { path: '/repos/owner/project/pulls/42/comments/77/replies', method: 'POST', body: { body: 'Follow-up.' } },
    { path: '/repos/owner/project/pulls/42/reviews', method: 'POST', body: { commit_id: sha, body: 'Summary.', event: 'COMMENT', comments: [{ path: 'src/file.js', line: 2, side: 'RIGHT', body: 'Line.' }] } },
    { path: '/repos/owner/project/pulls/42/reviews', method: 'GET', body: undefined },
    { path: '/repos/owner/project/pulls/42/reviews/88/comments', method: 'GET', body: undefined },
  ]);
});

test('public reads work without auth, but mutation fails before fetch', async () => {
  let calls = 0;
  const github = new GitHub({ fetch: async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, undefined);
    return json(pull);
  } });
  await github.getPull('owner/project', 42);
  await assert.rejects(github.createComment('owner/project', 42, 'Hello'), /authentication is required/);
  assert.equal(calls, 1);
});

test('list comments follows next links including a full first page', async () => {
  const seen = [];
  const next = 'https://api.github.com/repos/owner/project/issues/42/comments?per_page=100&page=2';
  const github = new GitHub({ fetch: async (url) => {
    seen.push(url);
    return seen.length === 1 ? json(Array.from({ length: 100 }, (_, id) => ({ id })), 200, { link: `<${next}>; rel="next", <${next}>; rel="last"` }) : json([{ id: 100 }]);
  } });
  assert.equal((await github.listComments('owner/project', 42)).length, 101);
  assert.equal(seen[1], next);
});

test('pagination will not leak credentials to another origin', async () => {
  let calls = 0;
  const github = new GitHub({ token: 'test-token', fetch: async () => {
    calls++;
    return json([], 200, { link: '<https://attacker.test/comments?page=2>; rel="next"' });
  } });
  await assert.rejects(github.listComments('owner/project', 42), /unexpected API URL/);
  assert.equal(calls, 1);
});

test('API errors redact tokens and never retry failed writes', async () => {
  let calls = 0;
  const github = new GitHub({ token: 'test-token', fetch: async () => {
    calls++;
    return json({ message: 'Invalid test-token' }, 403);
  } });
  await assert.rejects(github.createComment('owner/project', 42, 'Hello'), error => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.status, 403);
    assert.match(error.message, /permissions/);
    assert.equal(error.message.includes('test-token'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('ambiguous transport failures explain that publication may have succeeded', async () => {
  let calls = 0;
  const github = new GitHub({ token: 'test-token', fetch: async () => {
    calls++;
    throw new Error('Connection reset test-token');
  } });
  await assert.rejects(github.createComment('owner/project', 42, 'Hello'), error => {
    assert.match(error.message, /may have reached GitHub/);
    assert.equal(error.message.includes('test-token'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('viewer identity uses authenticated user for ordinary tokens', async () => {
  const github = new GitHub({ token: 'test-token', fetch: async (url) => {
    assert.equal(url, 'https://api.github.com/user');
    return json({ id: 9, login: 'person' });
  } });
  assert.deepEqual(await github.getViewer(), { id: 9, login: 'person' });
});

test('an interrupted response body is a sanitized ambiguous write failure', async () => {
  const github = new GitHub({ token: 'test-token', fetch: async () => ({ text: async () => { throw new Error('stream failed test-token'); } }) });
  await assert.rejects(github.createComment('owner/project', 42, 'Hello'), error => {
    assert.match(error.message, /may have reached GitHub/);
    assert.equal(error.message.includes('test-token'), false);
    return true;
  });
});

test('invalid JSON after a mutation warns against blindly retrying', async () => {
  const github = new GitHub({ token: 'test-token', fetch: async () => new Response('<html>Service unavailable</html>', { status: 502 }) });
  await assert.rejects(github.createComment('owner/project', 42, 'Hello'), /may have reached GitHub/);
});

test('JSON HTTP 503 after a mutation warns about an ambiguous outcome without retrying', async () => {
  let calls = 0;
  const github = new GitHub({ token: 'test-token', fetch: async () => {
    calls++;
    return json({ message: 'Service unavailable' }, 503);
  } });
  await assert.rejects(github.createComment('owner/project', 42, 'Hello'), error => {
    assert.equal(error.status, 503);
    assert.match(error.message, /may have reached GitHub/);
    assert.match(error.message, /check the PR before retrying/);
    return true;
  });
  assert.equal(calls, 1);
});

test('viewer identity falls back to GraphQL for installation tokens', async () => {
  const seen = [];
  const github = new GitHub({ token: 'test-token', fetch: async (url, options) => {
    seen.push(url);
    if (url.endsWith('/user')) return json({ message: 'Resource not accessible by integration' }, 403);
    assert.equal(url, 'https://api.github.com/graphql');
    assert.deepEqual(JSON.parse(options.body), { query: 'query { viewer { login databaseId } }' });
    return json({ data: { viewer: { databaseId: 41898282, login: 'github-actions[bot]' } } });
  } });
  assert.deepEqual(await github.getViewer(), { id: 41898282, login: 'github-actions[bot]' });
  assert.equal(seen.length, 2);
});

test('viewer fallback fails closed when API cannot establish identity', async () => {
  const github = new GitHub({ token: 'test-token', fetch: async (url) => url.endsWith('/user')
    ? json({ message: 'Forbidden' }, 403) : json({ errors: [{ message: 'Forbidden' }], data: { viewer: null } }) });
  await assert.rejects(github.getViewer(), /Could not verify the authenticated/);
});

test('resolveContext accepts an explicit URL without local git or an Actions event', async () => {
  const github = { getPull: async (repo, number) => {
    assert.equal(repo, 'owner/project');
    assert.equal(number, 42);
    return pull;
  } };
  const context = await resolveContext({ pr: 'https://github.com/owner/project/pull/42', env: {}, run: noRun, github });
  assert.equal(context.repo, 'owner/project');
  assert.equal(context.number, 42);
  assert.equal(context.headSha, sha);
  assert.equal(context.headRepo, 'contributor/project');
});

test('Actions resolve PR number and base repo while head SHA comes from the API', async () => {
  const context = await resolveContext({
    env: { GITHUB_EVENT_PATH: '/fake/event.json', GITHUB_REPOSITORY: 'owner/project', GITHUB_SHA: 'merge-sha', GITHUB_ACTOR: 'workflow-triggerer' },
    run: noRun,
    readFile: async () => JSON.stringify({ number: 42, pull_request: { number: 42, head: { sha: 'stale-event-sha' }, base: { repo: { full_name: 'owner/project' } } } }),
    github: { getPull: async (repo, number) => { assert.equal(repo, 'owner/project'); assert.equal(number, 42); return pull; } },
  });
  assert.equal(context.headSha, sha);
});

test('issue_comment Actions event only selects an issue that is a PR', async () => {
  const context = await resolveContext({
    env: { GITHUB_EVENT_PATH: '/fake/event.json', GITHUB_REPOSITORY: 'owner/project' }, run: noRun,
    readFile: async () => JSON.stringify({ issue: { number: 42, pull_request: {} } }),
    github: { getPull: async () => pull },
  });
  assert.equal(context.number, 42);
});

test('context rejects conflicting explicit destinations before requests', async () => {
  await assert.rejects(resolveContext({ repo: 'other/project', pr: 'https://github.com/owner/project/pull/42', env: {}, run: noRun }), /does not match/);
});

test('branch discovery supports fork origin with upstream destination', async () => {
  const run = async (command, args) => {
    assert.equal(command, 'git');
    if (args.join(' ') === 'remote get-url origin') return 'git@github.com:contributor/project.git';
    if (args.join(' ') === 'remote get-url upstream') return 'git@github.com:owner/project.git';
    if (args.join(' ') === 'branch --show-current') return 'feature';
    throw new Error('Unexpected command');
  };
  const context = await resolveContext({ env: {}, run, github: {
    findPull: async (repo, head) => { assert.equal(repo, 'owner/project'); assert.equal(head, 'contributor:feature'); return { number: 42 }; },
    getPull: async () => pull,
  } });
  assert.equal(context.repo, 'owner/project');
});

test('branch discovery does not silently select among several PRs', async () => {
  const github = new GitHub({ fetch: async () => json([{ number: 1 }, { number: 2 }]) });
  await assert.rejects(github.findPull('owner/project', 'owner:feature'), /Multiple open pull requests/);
});

test('an explicit repo does not reuse a different Actions repository PR number', async () => {
  await assert.rejects(resolveContext({
    repo: 'other/project', env: { GITHUB_EVENT_PATH: '/fake/event.json', GITHUB_REPOSITORY: 'owner/project' }, run: noRun,
    readFile: async () => JSON.stringify({ number: 42, pull_request: {} }), github: {},
  }), /Could not determine the current branch/);
});

test('detached checkouts require explicit PR or Actions context', async () => {
  await assert.rejects(resolveContext({ repo: 'owner/project', env: {}, run: noRun, github: {} }), /checkout may be detached/);
});

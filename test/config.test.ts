import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig } from '../src/config.js';

const exec = promisify(execFile);

async function fixture(t: TestContext, { git = false }: { git?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gh-comment-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (git) await exec('git', ['-C', root, 'init', '--quiet']);
  return {
    root,
    write: (value: unknown, name = CONFIG_FILENAME) => writeFile(path.join(root, name), JSON.stringify(value)),
  };
}

test('missing automatic config uses exact duplicate checks with a dormant 96% threshold', async t => {
  const { root } = await fixture(t);
  assert.deepEqual(await loadConfig({ cwd: root }), { dedupe: 'exact', similarityThreshold: 0.96 });
  const result = await loadConfig({ cwd: root });
  result.dedupe = 'off';
  assert.equal(DEFAULT_CONFIG.dedupe, 'exact');
});

test('discovers config at the selected checkout root from a nested directory', async t => {
  const { root, write } = await fixture(t, { git: true });
  const nested = path.join(root, 'src', 'nested');
  await mkdir(nested, { recursive: true });
  await write({ dedupe: 'similar', similarityThreshold: 0.98 });
  await writeFile(path.join(nested, CONFIG_FILENAME), JSON.stringify({ dedupe: 'off' }));
  assert.deepEqual(await loadConfig({ cwd: os.tmpdir(), checkout: nested }), { dedupe: 'similar', similarityThreshold: 0.98 });
});

test('outside Git, automatic config is limited to the selected checkout directory', async t => {
  const { root, write } = await fixture(t);
  await write({ dedupe: 'off' });
  assert.deepEqual(await loadConfig({ cwd: path.relative(process.cwd(), root) }), { dedupe: 'off', similarityThreshold: 0.96 });
  const checkout = path.join(root, 'project');
  await mkdir(checkout);
  assert.deepEqual(await loadConfig({ cwd: root, checkout: 'project' }), DEFAULT_CONFIG);
  await writeFile(path.join(checkout, CONFIG_FILENAME), JSON.stringify({ dedupe: 'similar' }));
  assert.deepEqual(await loadConfig({ cwd: root, checkout: 'project' }), { dedupe: 'similar', similarityThreshold: 0.96 });
});

test('explicit config path resolves from the shell directory and replaces automatic discovery', async t => {
  const { root, write } = await fixture(t, { git: true });
  await write({ dedupe: 'off' });
  await write({ dedupe: 'similar' }, 'custom.json');
  const checkout = path.join(root, 'src');
  await mkdir(checkout);
  assert.deepEqual(await loadConfig({ cwd: root, checkout, configPath: 'custom.json' }), { dedupe: 'similar', similarityThreshold: 0.96 });
  await assert.rejects(loadConfig({ cwd: checkout, configPath: 'custom.json' }), /Could not read configuration file/);
});

test('CLI overrides file values and leaves unspecified settings intact', async t => {
  const { root, write } = await fixture(t);
  await write({ dedupe: 'off', similarityThreshold: 0.99 });
  assert.deepEqual(await loadConfig({ cwd: root, overrides: { dedupe: 'similar', similarityThreshold: undefined } }), { dedupe: 'similar', similarityThreshold: 0.99 });
  assert.deepEqual(await loadConfig({ cwd: root, overrides: { similarityThreshold: '0.97' } }), { dedupe: 'off', similarityThreshold: 0.97 });
});

test('a threshold does not implicitly enable similar duplicate checks', async t => {
  const { root, write } = await fixture(t);
  await write({ similarityThreshold: 0.9 });
  assert.deepEqual(await loadConfig({ cwd: root }), { dedupe: 'exact', similarityThreshold: 0.9 });
  assert.deepEqual(await loadConfig({ cwd: root, overrides: { dedupe: 'off', similarityThreshold: '1' } }), { dedupe: 'off', similarityThreshold: 1 });
});

test('rejects malformed JSON and unknown settings without echoing secret values', async t => {
  const { root, write } = await fixture(t);
  await writeFile(path.join(root, CONFIG_FILENAME), '{"token":"private-secret"');
  await assert.rejects(loadConfig({ cwd: root }), (error: unknown) => {
    if (!(error instanceof Error)) return false;
    return /not valid JSON/.test(error.message) && !error.message.includes('private-secret');
  });
  await write({ token: 'private-secret' });
  await assert.rejects(loadConfig({ cwd: root }), (error: unknown) => {
    if (!(error instanceof Error)) return false;
    return /Unknown setting "token"/.test(error.message) && !error.message.includes('private-secret');
  });
});

test('rejects invalid file settings even when CLI overrides would mask them', async t => {
  const { root, write } = await fixture(t);
  for (const settings of [null, [], 'similar', { dedupe: 'fuzzy' }, { dedupe: null }, { similarityThreshold: '0.96' }, { similarityThreshold: 0 }, { similarityThreshold: -1 }, { similarityThreshold: 1.1 }]) {
    await write(settings);
    await assert.rejects(loadConfig({ cwd: root, overrides: { dedupe: 'exact', similarityThreshold: 0.96 } }));
  }
});

test('rejects invalid CLI thresholds, modes, and missing explicit config files', async t => {
  const { root } = await fixture(t);
  for (const threshold of ['', ' ', 'NaN', 'Infinity', '96%', '0x1', '0', '1.01', -1, null, Infinity, NaN]) {
    await assert.rejects(loadConfig({ cwd: root, overrides: { similarityThreshold: threshold } }), /similarityThreshold/);
  }
  await assert.rejects(loadConfig({ cwd: root, overrides: { dedupe: 'automatic' } }), /dedupe/);
  await assert.rejects(loadConfig({ cwd: root, configPath: 'missing.json' }), /Could not read configuration file/);
  await assert.rejects(loadConfig({ cwd: root, configPath: '' }), /--config must name/);
});

test('accepts a UTF-8 BOM and reports unreadable configuration paths', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, CONFIG_FILENAME), '\uFEFF{"dedupe":"similar"}');
  assert.deepEqual(await loadConfig({ cwd: root }), { dedupe: 'similar', similarityThreshold: 0.96 });
  await mkdir(path.join(root, 'directory.json'));
  await assert.rejects(loadConfig({ cwd: root, configPath: 'directory.json' }), /Could not read configuration file/);
});

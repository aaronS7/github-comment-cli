import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
const temporary = await mkdtemp(path.join(tmpdir(), 'gh-comment-package-'));

function npm(...args: string[]): string {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || `npm ${args[0]} failed`);
  return result.stdout;
}

try {
  const metadata = JSON.parse(npm('pack', '--json', '--ignore-scripts', '--pack-destination', temporary)) as
    { filename: string; files: { path: string }[] }[];
  const packed = metadata[0];
  assert.ok(packed);
  const files = new Set(packed.files.map(file => file.path));
  for (const file of ['bin/gh-comment.js', 'build/src/cli.js', 'build/mint-app-token.js', 'build/config-ui-server.js']) {
    assert.ok(files.has(file), `Package is missing ${file}`);
  }
  assert.ok(![...files].some(file => (file.endsWith('.ts') && !file.endsWith('.d.ts')) || file.startsWith('build/test/')),
    'Package contains TypeScript source or compiled tests');

  const installRoot = path.join(temporary, 'consumer');
  npm('install', '--prefix', installRoot, '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, packed.filename));
  const executable = path.join(installRoot, 'node_modules', 'github-comment-cli', 'bin', 'gh-comment.js');
  const result = spawnSync(process.execPath, [executable, '--version'], { encoding: 'utf8', cwd: installRoot });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Installed CLI failed');
  assert.equal(result.stdout.trim(), version);
  const render = spawnSync(process.execPath, [executable, 'render', 'examples/review.md', '--repo', 'aaronS7/github-comment-cli'], {
    encoding: 'utf8', cwd: root,
  });
  assert.equal(render.status, 0, render.stderr || render.error?.message || 'Installed CLI render failed');
  assert.match(render.stdout, /github\.com\/aaronS7\/github-comment-cli\/blob\/[a-f0-9]{40}\/examples\/demo\.js#L3-L5/);
  const previewPath = path.join(temporary, 'preview.html');
  const preview = spawnSync(process.execPath, [executable, 'preview', 'examples/review.md', '--repo', 'aaronS7/github-comment-cli', '--output', previewPath], {
    encoding: 'utf8', cwd: root,
  });
  assert.equal(preview.status, 0, preview.stderr || preview.error?.message || 'Installed CLI preview failed');
  assert.match(await readFile(previewPath, 'utf8'), /github\.com\/aaronS7\/github-comment-cli\/blob\/[a-f0-9]{40}\/examples\/demo\.js#L3-L5/);
  process.stdout.write('Package install smoke test passed.\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

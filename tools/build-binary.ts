import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error(`Release tag ${process.env.GITHUB_REF_NAME} does not match package version v${version}`);
}
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const arch = process.arch;
if (!['linux', 'darwin', 'windows'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  throw new Error(`Unsupported release platform: ${platform}-${arch}`);
}

const target = `${platform}-${arch}`;
const expected = process.argv[2];
if (expected && expected !== target) throw new Error(`Expected ${expected}, running on ${target}`);

const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });
const temporary = await mkdtemp(path.join(tmpdir(), 'gh-comment-sea-'));
const output = path.join(dist, `gh-comment-v${version}-${target}${platform === 'windows' ? '.exe' : ''}`);

try {
  const main = path.join(temporary, 'main.cjs');
  await build({
    entryPoints: [path.join(root, 'build/tools/sea-entry.js')],
    outfile: main,
    platform: 'node',
    format: 'cjs',
    target: 'node26',
    bundle: true,
    logLevel: 'info',
  });
  const config = path.join(temporary, 'sea-config.json');
  await writeFile(config, JSON.stringify({
    main,
    mainFormat: 'commonjs',
    output,
    disableExperimentalSEAWarning: true,
  }));
  const { stdout, stderr } = await exec(process.execPath, ['--build-sea', config], { cwd: root });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (platform === 'darwin') await exec('codesign', ['--sign', '-', output]);
  if (platform !== 'windows') await chmod(output, 0o755);
  const archive = `${output}.tar.gz`;
  await exec('tar', ['-czf', archive, '-C', dist, path.basename(output)]);
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${hash}  ${path.basename(archive)}\n`);
  process.stdout.write(`${archive}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

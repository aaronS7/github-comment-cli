import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const KEYS = new Set(['dedupe', 'similarityThreshold']);
export const CONFIG_FILENAME = '.gh-comment.json';
export const DEFAULT_CONFIG = Object.freeze({ dedupe: 'exact', similarityThreshold: 0.96 });

function validate(values, source, { cli = false } = {}) {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`${source} must contain a JSON object.`);
  }
  const normalized = {};
  for (const [key, value] of Object.entries(values)) {
    if (!KEYS.has(key)) throw new Error(`Unknown setting "${key}" in ${source}. Supported settings: dedupe, similarityThreshold.`);
    if (value === undefined && cli) continue;
    if (key === 'dedupe') {
      if (!['off', 'exact', 'similar'].includes(value)) {
        throw new Error(`dedupe in ${source} must be "off", "exact", or "similar".`);
      }
      normalized.dedupe = value;
    } else {
      let threshold = value;
      if (cli && typeof value === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
        threshold = Number(value);
      }
      if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
        throw new Error(`similarityThreshold in ${source} must be a number greater than 0 and at most 1 (for example, 0.96).`);
      }
      normalized.similarityThreshold = threshold;
    }
  }
  return normalized;
}

async function defaultConfigPath(checkout) {
  let root = checkout;
  try {
    const { stdout } = await exec('git', ['-C', checkout, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
    root = stdout.trimEnd();
  } catch {
    // Plain Markdown can be posted without a Git checkout when the PR is explicit.
  }
  return path.join(root, CONFIG_FILENAME);
}

/** Load local JSON configuration before any GitHub reads or writes. */
export async function loadConfig({ cwd = process.cwd(), checkout, configPath, overrides = {} } = {}) {
  const shellCwd = path.resolve(cwd);
  const checkoutCwd = checkout === undefined ? shellCwd : path.resolve(shellCwd, checkout);
  if (configPath !== undefined && (typeof configPath !== 'string' || configPath.length === 0)) {
    throw new Error('--config must name a JSON configuration file.');
  }
  const overrideValues = validate(overrides, 'CLI options', { cli: true });
  const filename = configPath === undefined
    ? await defaultConfigPath(checkoutCwd)
    : path.resolve(shellCwd, configPath);
  let contents;
  try {
    contents = await readFile(filename, 'utf8');
  } catch (cause) {
    if (configPath === undefined && cause.code === 'ENOENT') return { ...DEFAULT_CONFIG, ...overrideValues };
    throw new Error(`Could not read configuration file "${filename}" (${cause.code ?? 'read error'}).`, { cause });
  }
  let values;
  try {
    values = JSON.parse(contents.replace(/^\uFEFF/, ''));
  } catch (cause) {
    throw new Error(`Configuration file "${filename}" is not valid JSON.`, { cause });
  }
  const fileValues = validate(values, `configuration file "${filename}"`);
  return { ...DEFAULT_CONFIG, ...fileValues, ...overrideValues };
}

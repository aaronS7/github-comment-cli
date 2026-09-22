import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Repository } from './git.js';
import { parseRepo, resolveContext } from './github.js';
import { hasKeyMarker, renderMarkdown, SEPARATOR, validateBody } from './markdown.js';
import { loadConfig } from './config.js';
import { describeDecision, planPublication, publish } from './publish.js';
import { Attachments } from './attachments.js';

export { publish } from './publish.js';

const HELP = `gh-comment — Markdown comments for GitHub pull requests

Usage:
  gh-comment render <file.md|-> [options]
  gh-comment post   <file.md|-> [options]

Commands:
  render       Print validated Markdown. Offline unless --pr is supplied.
  post         Publish to the PR conversation, or update one comment with --key.

Options:
  --pr <number|url>  Pull request; post can infer it from branch or Actions event
  --repo <owner/repo>  Destination repository; otherwise inferred
  --cwd <directory> Local checkout (default: current directory)
  --sha <commit>    Commit for offline render (default: HEAD)
  --key <name>      Update your single comment with this key on repeated runs
  --dedupe <mode>   exact (default), similar, or off; compare your PR comments
  --similarity-threshold <0..1>  Similar-mode threshold (default: 0.96; > 0)
  --config <file>   JSON settings (default: .gh-comment.json in checkout root)
  --attach <file|URL>  Attach an extra image/video (repeatable; files shell-relative)
  --attachment-base <dir>  Base for Markdown media paths (default: report folder)
  --upload-remote-images   Download and re-upload remote Markdown images
  --attachment-memory-limit <MiB>  Snapshot memory budget (default: 8; spill to disk)
  --allow-private-network  Allow LAN/loopback downloads with remote-image opt-in
  --dry-run         Show planned writes/skips without publishing (post only)
  --json            Emit structured JSON instead of Markdown or comment URLs
  --help, -h        Show this help
  --version, -v     Show version

Write [label](src/file.ts:42-48) or [label](src/file.ts#L42-L48).
Paths are relative to the repository root, or absolute inside the checkout.
Separate comments with a standalone ${SEPARATOR}.
Local Markdown images/media are uploaded; paths are relative to the report file.
Code blocks and inline code stay literal. Referenced code must match the commit.
Authenticate with GH_TOKEN, GITHUB_TOKEN, or gh auth login.
Duplicate checks require authentication, including post --dry-run.
Similar matching is opt-in. --key updates changed content regardless of similarity.
CLI options override config settings; the threshold applies only to similar mode.
`;

function parse(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    pr: { type: 'string' }, repo: { type: 'string' }, cwd: { type: 'string' },
    sha: { type: 'string' }, key: { type: 'string' },
    dedupe: { type: 'string' }, 'similarity-threshold': { type: 'string' }, config: { type: 'string' },
    attach: { type: 'string', multiple: true }, 'attachment-base': { type: 'string' },
    'upload-remote-images': { type: 'boolean' }, 'attachment-memory-limit': { type: 'string' },
    'allow-private-network': { type: 'boolean' },
    'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.help || values.version) return { ...values };
  if (positionals.length !== 2 || !['render', 'post'].includes(positionals[0])) {
    throw new Error('Expected: gh-comment render|post <file.md|->. Run gh-comment --help for examples.');
  }
  const [command, file] = positionals;
  if (values.sha !== undefined && (command === 'post' || values.pr !== undefined)) {
    throw new Error('--sha is only available for offline render. PR comments always use the current PR head commit.');
  }
  if (values['dry-run'] && command !== 'post') throw new Error('--dry-run is for post; render already previews without publishing.');
  if (values.key !== undefined && !/^[A-Za-z0-9_.-]{1,100}$/.test(values.key)) {
    throw new Error('--key must contain 1–100 letters, numbers, dots, underscores, or hyphens.');
  }
  if (values.dedupe !== undefined && !['off', 'exact', 'similar'].includes(values.dedupe)) {
    throw new Error('--dedupe must be off, exact, or similar.');
  }
  if (values['similarity-threshold'] !== undefined) {
    const raw = values['similarity-threshold'].trim();
    const threshold = Number(raw);
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)
      || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new Error('--similarity-threshold must be a number greater than 0 and at most 1 (for example, 0.96).');
    }
  }
  if (values['allow-private-network'] && !values['upload-remote-images']) {
    throw new Error('--allow-private-network requires --upload-remote-images.');
  }
  if (values['attachment-memory-limit'] !== undefined) {
    const value = values['attachment-memory-limit'];
    const bytes = Number(value) * 1024 * 1024;
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 100 * 1024 * 1024) {
      throw new Error('--attachment-memory-limit must be a positive MiB value up to 100, representing a whole number of bytes.');
    }
  }
  if (values.attach?.some(value => !value.trim())) throw new Error('--attach requires a file path or URL.');
  for (const name of ['repo', 'pr', 'cwd', 'sha', 'config', 'attachment-base']) {
    if (values[name] !== undefined && !values[name].trim()) throw new Error(`--${name} cannot be empty.`);
  }
  return { ...values, command, file };
}

async function input(file, cwd, stdin) {
  if (file !== '-') {
    try { return await readFile(path.resolve(cwd, file), 'utf8'); }
    catch { throw new Error(`Could not read Markdown file: ${file}`); }
  }
  if (stdin.isTTY) throw new Error('Pipe Markdown to stdin when using "-".');
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** Validate all entries and references before any GitHub write. */
export async function prepare(options, { cwd = process.cwd(), env = process.env, stdin = process.stdin, github, repository, markdown } = {}) {
  const checkout = path.resolve(cwd, options.cwd ?? '.');
  const settings = await loadConfig({ cwd, checkout, configPath: options.config, overrides: {
    dedupe: options.dedupe, similarityThreshold: options['similarity-threshold'],
  } });
  // Input file paths follow the shell working directory; --cwd only selects the checkout.
  const source = markdown ?? await input(options.file, cwd, stdin);
  let local = repository;
  const getRepository = async () => local ??= await Repository.discover(checkout);
  const online = options.command === 'post' || options.pr !== undefined;
  let context;
  let repo;
  let sha;
  let linkRepo;
  if (online) {
    if (env.GITHUB_SERVER_URL && new URL(env.GITHUB_SERVER_URL).origin !== 'https://github.com') {
      throw new Error('This version supports github.com repositories. GitHub Enterprise support is not implemented yet.');
    }
    context = await resolveContext({ repo: options.repo, pr: options.pr, cwd: checkout, env, github });
    repo = context.repo;
    sha = context.headSha;
    linkRepo = context.headRepo;
  } else {
    const checkoutRepo = await getRepository();
    repo = options.repo ? parseRepo(options.repo) : (await checkoutRepo.remote()).fullName;
    sha = await checkoutRepo.resolveCommit(options.sha ?? 'HEAD');
    linkRepo = repo;
  }
  const rendered = !source.trim() && options.attach?.length ? [{ body: '' }]
    : await renderMarkdown(source, async target => (await getRepository()).resolveReference(target, { sha, repo: linkRepo }));
  const attachments = new Attachments({
    cwd,
    baseDir: options['attachment-base'] ? path.resolve(cwd, options['attachment-base'])
      : options.file === '-' ? cwd : path.dirname(path.resolve(cwd, options.file)),
    explicit: options.attach, uploadRemote: options['upload-remote-images'],
    offline: options.command === 'render', allowPrivateNetwork: options['allow-private-network'],
    memoryLimitBytes: options['attachment-memory-limit'] === undefined ? undefined : Number(options['attachment-memory-limit']) * 1024 * 1024,
  });
  const comments = await attachments.prepare(rendered);
  let marker;
  try {
    if (options.key !== undefined) {
      if (comments.length !== 1) throw new Error('--key requires a single comment. Remove the separators or publish without --key.');
      marker = `<!-- gh-comment:key:${options.key} -->`;
      comments[0].body += `\n\n${marker}`;
      validateBody(comments[0].body);
      if (!hasKeyMarker(comments[0].body, marker)) {
        throw new Error('The --key marker would be inside an open Markdown block. Close any unfinished code fence or HTML block before publishing.');
      }
    }
    for (const { body } of comments) attachments.validate(body);
    return { repo, pr: context?.number ?? null, sha, comments, context, marker, settings, attachments };
  } catch (error) { await attachments.dispose(); throw error; }
}

export function preview(plan) {
  return { repo: plan.repo, pr: plan.pr, sha: plan.sha, comments: plan.comments,
    ...(plan.attachments?.active || plan.attachments?.pending.length ? { attachments: plan.attachments.describe(plan.comments.map(entry => ({ ...entry, action: 'created' }))) } : {}) };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let options;
  let plan;
  try { options = parse(argv); }
  catch (error) { stderr.write(`gh-comment: ${error.message}\n`); return 2; }
  if (options.help) { stdout.write(HELP); return 0; }
  if (options.version) { stdout.write('0.1.0\n'); return 0; }
  try {
    plan = await prepare(options, io);
    if (options.command === 'render') {
      stdout.write(options.json ? `${JSON.stringify(preview(plan), null, 2)}\n` : `${plan.comments.map(entry => entry.body).join(`\n\n${SEPARATOR}\n\n`)}\n`);
    } else if (options['dry-run']) {
      const result = await planPublication(plan);
      if (plan.attachments?.active) result.comments = result.comments.map(entry => ({ ...entry, body: plan.attachments.materialize(entry.body, { preview: true }) }));
      if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        stdout.write(`${result.comments.map(entry => entry.body).join(`\n\n${SEPARATOR}\n\n`)}\n`);
        result.comments.forEach((entry, index) => stderr.write(`${describeDecision(entry, index, { dryRun: true })}\n`));
      }
    } else {
      const result = await publish(plan);
      stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.comments.map(comment => comment.url).join('\n')}\n`);
      if (!options.json) result.comments.forEach((entry, index) => stderr.write(`${describeDecision(entry, index)}\n`));
    }
    return 0;
  } catch (error) {
    stderr.write(`gh-comment: ${error.message}\n`);
    return 1;
  } finally { await plan?.attachments?.dispose(); }
}

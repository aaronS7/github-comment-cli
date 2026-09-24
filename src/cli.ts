import type { ContextGitHub } from './github.js';
import type { ReviewTargetGitHub, ReplyTargetGitHub } from './review-threads.js';
import { errorMessage, type GitHubContext } from './github-types.js';
import type { CommentEntry, Config } from './types.js';
import type { PublicationPlan, PublicationGitHub } from './publication-types.js';

export type CliGitHub = ContextGitHub & PublicationGitHub & ReviewTargetGitHub & ReplyTargetGitHub;
export interface CliOptions {
  command: string; file: string;
  pr?: string; repo?: string; cwd?: string; output?: string; sha?: string; key?: string;
  dedupe?: string; 'similarity-threshold'?: string; config?: string; attach?: string[];
  'attachment-base'?: string; 'upload-remote-images'?: boolean; 'attachment-memory-limit'?: string;
  'allow-private-network'?: boolean; 'dry-run'?: boolean; json?: boolean; help?: boolean; version?: boolean;
}
export interface CliInput extends AsyncIterable<string | Uint8Array> { isTTY?: boolean }
export interface CliIO {
  cwd?: string; env?: NodeJS.ProcessEnv; stdin?: CliInput; github?: CliGitHub; repository?: Repository; markdown?: string;
  stdout?: {write(value: string): unknown}; stderr?: {write(value: string): unknown};
}
export interface PreparedPlan extends Omit<PublicationPlan, 'context' | 'pr'> {
  context: GitHubContext<CliGitHub> | undefined; pr: number | null; settings: Config; attachments: Attachments;
}

import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Repository } from './git.js';
import { parseRepo, resolveContext } from './github.js';
import { hasKeyMarker, renderMarkdown, SEPARATOR, validateBody } from './markdown.js';
import { loadConfig } from './config.js';
import { describeDecision, planPublication, publish } from './publish.js';
import { Attachments } from './attachments.js';
import { validateReplyTargets, validateReviewTargets } from './review-threads.js';
import { renderPreviewHtml } from './visual-preview.js';

export { publish } from './publish.js';

const HELP = `gh-comment — Markdown comments for GitHub pull requests

Usage:
  gh-comment render <file.md|-> [options]
  gh-comment preview <file.md|-> [options]
  gh-comment post   <file.md|-> [options]

Commands:
  render       Print validated Markdown. Offline unless --pr is supplied.
  preview      Write a GitHub-like local HTML preview; never publish.
  post         Publish PR comments, resolvable threads, replies, or a batch review.

Options:
  --pr <number|url>  Pull request; post can infer it from branch or Actions event
  --repo <owner/repo>  Destination repository; otherwise inferred
  --cwd <directory> Local checkout (default: current directory)
  --sha <commit>    Commit for offline render or preview (default: HEAD)
  --output <file>  HTML destination for preview (default: private temporary file)
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
  --json            Emit structured JSON instead of normal command output
  --help, -h        Show this help
  --version, -v     Show version

Write [label](src/file.ts:42-48) or [label](src/file.ts#L42-L48).
Paths are relative to the repository root, or absolute inside the checkout.
Separate comments with a standalone ${SEPARATOR}.
Start an entry with <!-- gh-comment:thread path="src/file.ts" line="42-48" side="RIGHT" -->
to post a resolvable diff thread. Use LEFT for deleted lines. A thread needs a PR.
Use <!-- gh-comment:file path="src/file.ts" --> for a changed-file thread, or
<!-- gh-comment:reply id="123456789" --> to reply to a top-level review comment.
Start a report with <!-- gh-comment:review event="COMMENT" --> to submit its
summary and following line threads as one review. APPROVE and REQUEST_CHANGES
require explicit events. Review reports cannot mix in other entry kinds.
Local Markdown images/media are uploaded; paths are relative to the report file.
Code blocks and inline code stay literal. Referenced code must match the commit.
Authenticate with GH_TOKEN, GITHUB_TOKEN, or gh auth login.
Duplicate checks require authentication, including the default post --dry-run.
Similar matching is opt-in. --key updates changed content regardless of similarity.
CLI options override config settings; the threshold applies only to similar mode.
`;

function parse(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    pr: { type: 'string' }, repo: { type: 'string' }, cwd: { type: 'string' },
    output: { type: 'string' },
    sha: { type: 'string' }, key: { type: 'string' },
    dedupe: { type: 'string' }, 'similarity-threshold': { type: 'string' }, config: { type: 'string' },
    attach: { type: 'string', multiple: true }, 'attachment-base': { type: 'string' },
    'upload-remote-images': { type: 'boolean' }, 'attachment-memory-limit': { type: 'string' },
    'allow-private-network': { type: 'boolean' },
    'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.help || values.version) return { ...values };
  if (positionals.length !== 2 || !['render', 'preview', 'post'].includes(positionals[0])) {
    throw new Error('Expected: gh-comment render|preview|post <file.md|->. Run gh-comment --help for examples.');
  }
  const [command, file] = positionals;
  if (values.sha !== undefined && (command === 'post' || values.pr !== undefined)) {
    throw new Error('--sha is only available for offline render or preview. PR comments always use the current PR head commit.');
  }
  if (values.output !== undefined && command !== 'preview') throw new Error('--output is only available for preview.');
  if (values.output !== undefined && !values.output.trim()) throw new Error('--output cannot be empty.');
  if (values['dry-run'] && command !== 'post') throw new Error('--dry-run is for post; render and preview never publish.');
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
  for (const name of ['repo', 'pr', 'cwd', 'sha', 'config', 'attachment-base'] as const) {
    if (values[name] !== undefined && !values[name].trim()) throw new Error(`--${name} cannot be empty.`);
  }
  return { ...values, command, file };
}

async function input(file: string, cwd: string, stdin: CliInput) {
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
export async function prepare(options: CliOptions, { cwd = process.cwd(), env = process.env, stdin = process.stdin, github, repository, markdown }: CliIO = {}): Promise<PreparedPlan> {
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
  const rendered: CommentEntry[] = !source.trim() && options.attach?.length ? [{ body: '' }]
    : await renderMarkdown(source, async target => (await getRepository()).resolveReference(target, { sha, repo: linkRepo }));
  if (rendered.some(entry => entry.kind)) {
    if (!context) throw new Error('Review threads, file comments, replies, and reviews require a pull request. Pass --pr to render or preview.');
    if (options.key !== undefined) throw new Error('--key is only available for one PR conversation comment.');
    await validateReviewTargets(rendered, { github: context.github, repo, pr: context.number, pull: context.pull });
    await validateReplyTargets(rendered, { github: context.github, repo, pr: context.number });
  }
  const attachments = new Attachments({
    cwd,
    baseDir: options['attachment-base'] ? path.resolve(cwd, options['attachment-base'])
      : options.file === '-' ? cwd : path.dirname(path.resolve(cwd, options.file)),
    explicit: options.attach, uploadRemote: options['upload-remote-images'],
    offline: options.command !== 'post', allowPrivateNetwork: options['allow-private-network'],
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

export function preview(plan: PreparedPlan) {
  return { repo: plan.repo, pr: plan.pr, sha: plan.sha, comments: plan.comments,
    ...(plan.attachments?.active || plan.attachments?.pending.length ? { attachments: plan.attachments.describe(plan.comments.map(entry => ({ ...entry, action: 'created' }))) } : {}) };
}

async function writeVisualPreview(plan: PreparedPlan, options: CliOptions, cwd: string) {
  const html = await renderPreviewHtml(plan);
  const destination = options.output
    ? path.resolve(cwd, options.output)
    : path.join(await mkdtemp(path.join(tmpdir(), 'gh-comment-preview-')), 'preview.html');
  if (options.file !== '-') {
    const inputFile = path.resolve(cwd, options.file);
    const existingTarget = await realpath(destination).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (destination === inputFile || existingTarget === await realpath(inputFile)) {
      throw new Error('The preview output cannot overwrite the Markdown input file.');
    }
  }
  await writeFile(destination, html, 'utf8');
  return destination;
}

function displayBody(entry: CommentEntry) {
  let directive;
  if (entry.kind === 'thread') {
    const range = entry.startLine === entry.line ? entry.line : `${entry.startLine}-${entry.line}`;
    directive = `<!-- gh-comment:thread path="${entry.path}" line="${range}" side="${entry.side}" -->`;
  } else if (entry.kind === 'file') directive = `<!-- gh-comment:file path="${entry.path}" -->`;
  else if (entry.kind === 'reply') directive = `<!-- gh-comment:reply id="${entry.parentId}" -->`;
  else if (entry.kind === 'review') directive = `<!-- gh-comment:review event="${entry.event}" -->`;
  return directive ? `${directive}\n\n${entry.body}` : entry.body;
}

export async function main(argv = process.argv.slice(2), io: CliIO = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let options;
  let plan: PreparedPlan | undefined;
  try { options = parse(argv); }
  catch (error) { stderr.write(`gh-comment: ${errorMessage(error)}\n`); return 2; }
  if (options.help) { stdout.write(HELP); return 0; }
  if (options.version) { stdout.write('0.1.0\n'); return 0; }
  // parse returns without command/file only for the help/version cases above.
  const runOptions = options as CliOptions;
  try {
    plan = await prepare(runOptions, io);
    if (runOptions.command === 'render') {
      stdout.write(runOptions.json ? `${JSON.stringify(preview(plan), null, 2)}\n` : `${plan.comments.map(displayBody).join(`\n\n${SEPARATOR}\n\n`)}\n`);
    } else if (runOptions.command === 'preview') {
      const destination = await writeVisualPreview(plan, runOptions, io.cwd ?? process.cwd());
      stdout.write(runOptions.json
        ? `${JSON.stringify({ path: destination, repo: plan.repo, pr: plan.pr, sha: plan.sha }, null, 2)}\n`
        : `${destination}\n`);
    } else if (runOptions['dry-run']) {
      const result = await planPublication({ ...plan, pr: plan.pr!, context: plan.context! });
      if (plan.attachments?.active) result.comments = result.comments.map(entry => ({ ...entry, body: plan!.attachments.materialize(entry.body, { preview: true }) }));
      if (runOptions.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        stdout.write(`${result.comments.map(displayBody).join(`\n\n${SEPARATOR}\n\n`)}\n`);
        result.comments.forEach((entry, index) => stderr.write(`${describeDecision(entry, index, { dryRun: true })}\n`));
      }
    } else {
      const result = await publish({ ...plan, pr: plan.pr!, context: plan.context! });
      stdout.write(runOptions.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.comments.map(comment => comment.url).join('\n')}\n`);
      if (!runOptions.json) result.comments.forEach((entry, index) => stderr.write(`${describeDecision(entry, index)}\n`));
    }
    return 0;
  } catch (error) {
    stderr.write(`gh-comment: ${errorMessage(error)}\n`);
    return 1;
  } finally { await plan?.attachments?.dispose(); }
}

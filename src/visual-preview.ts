import type { CommentEntry } from './types.js';
import type { Attachments } from './attachments.js';
export interface PreviewPlan { repo: string; pr?: number | null; sha: string; comments: CommentEntry[]; attachments?: Pick<Attachments, 'assets'> }
type ImageSource = {name: string; reason: string; url?: undefined} | {name: string; url: string; reason?: undefined};
interface ImageSources { sources: Map<string, ImageSource>; trustedData: Set<string> }
import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { assetPlaceholder } from './attachment-metadata.js';

const INLINE_IMAGE_LIMIT = 2 * 1024 * 1024;
const TOTAL_IMAGE_LIMIT = 8 * 1024 * 1024;
const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

const CSS = `
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: #f6f8fa; color: #1f2328; font-size: 14px; line-height: 1.5; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
.page { width: min(100% - 32px, 900px); margin: 34px auto 80px; }
.masthead { margin-bottom: 28px; }
.eyebrow { display: inline-block; padding: 3px 9px; border: 1px solid #bf8700; border-radius: 999px; color: #7d4e00; background: #fff8c5; font-weight: 600; font-size: 12px; }
h1 { margin: 10px 0 3px; font-size: 26px; letter-spacing: -.03em; }
.subtitle, .metadata, .muted { color: #59636e; }
.subtitle { margin: 0; }
.metadata { display: flex; flex-wrap: wrap; gap: 5px 16px; margin-top: 12px; font-size: 12px; }
.metadata code, .location code { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
.review-group { margin-top: 25px; padding: 14px 16px 17px; border: 1px solid #d1d9e0; border-radius: 8px; background: #eef4ff; }
.group-heading { margin: 0 0 12px; font-weight: 600; color: #3b5b9b; }
.entry { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 10px; margin: 20px 0; }
.review-group .entry { margin: 10px 0 0; }
.avatar { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: #d8dee4; color: #59636e; font-weight: 700; }
.bubble { min-width: 0; overflow: hidden; border: 1px solid #d1d9e0; border-radius: 6px; background: #fff; }
.bubble-header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 10px; padding: 8px 14px; border-bottom: 1px solid #d1d9e0; background: #f6f8fa; }
.bubble-header strong { font-weight: 600; }
.bubble-header .kind { color: #59636e; font-size: 12px; }
.location { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 10px; padding: 9px 14px; border-bottom: 1px solid #d1d9e0; background: #f6f8fa; font-size: 12px; }
.location code { overflow-wrap: anywhere; }
.badge { display: inline-block; padding: 1px 7px; border: 1px solid #d1d9e0; border-radius: 999px; color: #59636e; background: #fff; font-size: 11px; font-weight: 600; }
.badge.resolvable { border-color: #a3d9a5; color: #1a7f37; background: #dafbe1; }
.markdown { padding: 15px 16px; overflow-wrap: anywhere; }
.markdown > :first-child { margin-top: 0; }
.markdown > :last-child { margin-bottom: 0; }
.markdown h1, .markdown h2 { border-bottom: 1px solid #d1d9e0; padding-bottom: .28em; }
.markdown h1 { font-size: 1.75em; }
.markdown h2 { font-size: 1.4em; }
.markdown h3 { font-size: 1.18em; }
.markdown h4, .markdown h5, .markdown h6 { font-size: 1em; }
.markdown p, .markdown ul, .markdown ol, .markdown blockquote, .markdown pre, .markdown table, .markdown details { margin: 0 0 16px; }
.markdown ul, .markdown ol { padding-left: 2em; }
.markdown li + li { margin-top: .25em; }
.markdown input[type=checkbox] { margin-right: .45em; }
.markdown blockquote { padding: 0 1em; border-left: 4px solid #d1d9e0; color: #59636e; }
.markdown code { padding: .15em .35em; border-radius: 4px; background: #eff1f3; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: .88em; }
.markdown pre { overflow: auto; padding: 14px 16px; border-radius: 6px; background: #f6f8fa; }
.markdown pre code { padding: 0; background: transparent; white-space: pre; }
.markdown pre code.language-suggestion { display: block; margin: -14px -16px; padding: 14px 16px; background: #dafbe1; }
.markdown img { max-width: 100%; height: auto; border-radius: 4px; }
.markdown table { display: block; width: max-content; max-width: 100%; overflow: auto; border-spacing: 0; border-collapse: collapse; }
.markdown th, .markdown td { padding: 6px 13px; border: 1px solid #d1d9e0; }
.markdown tr:nth-child(even) { background: #f6f8fa; }
.markdown details { padding: 9px 12px; border: 1px solid #d1d9e0; border-radius: 6px; }
.markdown summary { cursor: pointer; font-weight: 600; }
.markdown details > :last-child { margin-bottom: 0; }
.media-fallback { display: inline-block; padding: 9px 12px; border: 1px dashed #d1d9e0; border-radius: 6px; color: #59636e; background: #f6f8fa; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #e6edf3; }
  a { color: #58a6ff; }
  .subtitle, .metadata, .muted, .bubble-header .kind { color: #8b949e; }
  .eyebrow { border-color: #9e6a03; color: #f0b72f; background: #3d2d00; }
  .review-group { border-color: #30363d; background: #111c33; }
  .group-heading { color: #a5c2ff; }
  .avatar { background: #30363d; color: #c9d1d9; }
  .bubble { border-color: #30363d; background: #161b22; }
  .bubble-header, .location { border-color: #30363d; background: #21262d; }
  .badge { border-color: #30363d; color: #c9d1d9; background: #161b22; }
  .badge.resolvable { border-color: #238636; color: #7ee787; background: #0b2a16; }
  .markdown h1, .markdown h2, .markdown th, .markdown td, .markdown details { border-color: #30363d; }
  .markdown blockquote { border-color: #3d444d; color: #8b949e; }
  .markdown code, .markdown pre, .markdown tr:nth-child(even), .media-fallback { background: #21262d; }
  .markdown pre code.language-suggestion { background: #0b2a16; }
  .media-fallback { border-color: #3d444d; color: #8b949e; }
}`;

async function imageSources(attachments: PreviewPlan['attachments']): Promise<ImageSources> {
  const sources = new Map<string, ImageSource>();
  const trustedData = new Set<string>();
  let total = 0;
  for (const asset of attachments?.assets.values() ?? []) {
    const placeholder = assetPlaceholder(asset);
    if (!asset.contentType.startsWith('image/') || asset.size > INLINE_IMAGE_LIMIT || total + asset.size > TOTAL_IMAGE_LIMIT) {
      const reason = !asset.contentType.startsWith('image/') ? 'video attachment'
        : asset.size > INLINE_IMAGE_LIMIT ? 'image over 2 MiB' : '8 MiB preview image budget reached';
      sources.set(placeholder, { name: asset.name, reason });
      continue;
    }
    const body = asset.openBody();
    const bytes = Buffer.isBuffer(body) ? body : Buffer.concat(await Array.fromAsync(body), asset.size);
    const url = `data:${asset.contentType};base64,${bytes.toString('base64')}`;
    sources.set(placeholder, { name: asset.name, url });
    trustedData.add(url);
    total += asset.size;
  }
  return { sources, trustedData };
}

function markdownRenderer({ sources, trustedData }: ImageSources) {
  const marked = new Marked({ gfm: true, breaks: true, renderer: {
    image(token) {
      const asset = sources.get(token.href);
      if (asset && !asset.url) {
        return `<span class="media-fallback">${escapeHtml(asset.name)} · ${asset.reason} (shown after upload)</span>`;
      }
      const href = asset?.url ?? token.href;
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text)}"${token.title ? ` title="${escapeHtml(token.title)}"` : ''}>`;
    },
    link(token) {
      const asset = sources.get(token.href);
      if (asset && !asset.url) return `<span class="media-fallback">${escapeHtml(asset.name)} · ${asset.reason} (shown after upload)</span>`;
      return false;
    },
  } });
  return (body: string) => sanitizeHtml(marked.parse(body, {async: false}), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['details', 'summary', 'img', 'input', 'del']),
    allowedAttributes: {
      a: ['href', 'title'], img: ['src', 'alt', 'title'], code: ['class'],
      details: ['open'], input: ['type', 'checked', 'disabled'], th: ['align'], td: ['align'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: false,
    transformTags: {
      input: (_tag, attributes) => ({ tagName: 'input', attribs: { type: 'checkbox', disabled: '', ...(attributes.checked === undefined ? {} : { checked: '' }) } }),
      img: (_tag, attributes) => ({ tagName: 'img', attribs: {
        alt: attributes.alt ?? '',
        ...(typeof attributes.src === 'string' && (trustedData.has(attributes.src) || /^https?:\/\//i.test(attributes.src)) ? { src: attributes.src } : {}),
        ...(attributes.title ? { title: attributes.title } : {}),
      } }),
    },
  });
}

function entryLabel(entry: CommentEntry) {
  switch (entry.kind) {
    case 'review': return { title: `Review summary · ${entry.event}`, kind: 'PR review' };
    case 'thread': return { title: 'Inline review thread', kind: 'Files changed' };
    case 'file': return { title: 'Changed-file thread', kind: 'Files changed' };
    case 'reply': return { title: 'Review thread reply', kind: 'Files changed' };
    default: return { title: 'PR conversation comment', kind: 'Conversation' };
  }
}

function location(entry: CommentEntry) {
  if (entry.kind === 'thread') {
    const lines = entry.startLine === entry.line ? `L${entry.line}` : `L${entry.startLine}–L${entry.line}`;
    return `<div class="location"><code>${escapeHtml(entry.path)}:${lines}</code><span class="badge">${entry.side === 'LEFT' ? 'old side' : 'new side'}</span><span class="badge resolvable">Resolvable thread</span></div>`;
  }
  if (entry.kind === 'file') return `<div class="location"><code>${escapeHtml(entry.path)}</code><span class="badge resolvable">Resolvable thread</span></div>`;
  if (entry.kind === 'reply') return `<div class="location">Replies to review comment <code>#${escapeHtml(entry.parentId)}</code></div>`;
  return '';
}

function card(entry: CommentEntry, index: number, renderMarkdown: (body: string) => string) {
  const label = entryLabel(entry);
  return `<article class="entry">
    <div class="avatar" aria-hidden="true">?</div>
    <div class="bubble">
      <div class="bubble-header"><strong>${escapeHtml(label.title)}</strong><span class="kind">${escapeHtml(label.kind)} · entry ${index + 1}</span></div>
      ${location(entry)}
      <div class="markdown">${renderMarkdown(entry.body)}</div>
    </div>
  </article>`;
}

/** Build a local structural preview of the eventual PR conversation. No GitHub writes. */
export async function renderPreviewHtml(plan: PreviewPlan) {
  const renderMarkdown = markdownRenderer(await imageSources(plan.attachments));
  const summary = plan.comments[0];
  const review = summary?.kind === 'review';
  const cards = plan.comments.map((entry, index) => card(entry, index, renderMarkdown));
  const entries = review
    ? `<section class="review-group"><p class="group-heading">One ${escapeHtml(summary.event)} review · ${plan.comments.length - 1} inline ${plan.comments.length === 2 ? 'thread' : 'threads'}</p>${cards.join('')}</section>`
    : cards.join('');
  const prUrl = plan.pr ? `https://github.com/${plan.repo}/pull/${plan.pr}` : null;
  const title = `${plan.repo}${plan.pr ? ` · PR #${plan.pr}` : ''} · gh-comment preview`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(title)}</title>
  <style>${CSS}</style>
</head>
<body>
  <main class="page">
    <header class="masthead">
      <span class="eyebrow">Local preview · nothing posted</span>
      <h1>${escapeHtml(plan.repo)}${plan.pr ? ` / PR #${plan.pr}` : ''}</h1>
      <p class="subtitle">Approximate GitHub layout for comment placement and Markdown. The final avatar and styling come from GitHub.</p>
      <div class="metadata"><span>${prUrl ? `<a href="${escapeHtml(prUrl)}">Open pull request</a>` : 'Offline preview'}</span><span>Head <code>${escapeHtml(plan.sha.slice(0, 12))}</code></span><span>${plan.comments.length} ${plan.comments.length === 1 ? 'entry' : 'entries'}</span></div>
    </header>
    ${entries}
  </main>
</body>
</html>\n`;
}

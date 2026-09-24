import type { Nodes, Link, LinkReference, ImageReference, Definition, Html } from 'mdast';
import type { CommentEntry, ThreadEntry, FileEntry, ReplyEntry, ReviewEntry, Side, ReviewEvent } from './types.js';
import { errorMessage } from './github-types.js';
type LinkNode = Link | LinkReference | ImageReference;
type Placement = Omit<ThreadEntry, 'body'> | Omit<FileEntry, 'body'> | Omit<ReplyEntry, 'body'> | Omit<ReviewEntry, 'body'>;
interface Edit { start: number; end: number; text: string }
export type ReferenceResolver = (target: string) => Promise<{url: string}>;
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseLocalReference } from './git.js';

export const SEPARATOR = '<!-- gh-comment:next -->';
export const MAX_COMMENT_LENGTH = 65536;
const THREAD_DIRECTIVE = /^<!-- gh-comment:thread path="([^"\r\n]+)" line="([1-9]\d*)(?:-([1-9]\d*))?" side="(LEFT|RIGHT)" -->$/;
const FILE_DIRECTIVE = /^<!-- gh-comment:file path="([^"\r\n]+)" -->$/;
const REPLY_DIRECTIVE = /^<!-- gh-comment:reply id="([1-9]\d*)" -->$/;
const REVIEW_DIRECTIVE = /^<!-- gh-comment:review event="(COMMENT|APPROVE|REQUEST_CHANGES)" -->$/;
const ENTRY_DIRECTIVE = /^<!-- gh-comment:(?:thread|file|reply|review)(?=\s|-->|$)/;

function validPath(file: string) {
  return !file.startsWith('/') && !file.includes('\\') && !/[\x00-\x1f\x7f]/.test(file)
    && !file.split('/').some(part => !part || part === '.' || part === '..');
}

function parseThreadDirective(value: string, entry: number): Omit<ThreadEntry, 'body'> {
  const match = THREAD_DIRECTIVE.exec(value.trim());
  if (!match) {
    throw new Error(`Comment ${entry} has an invalid thread directive. Use <!-- gh-comment:thread path="file" line="12-15" side="RIGHT" -->.`);
  }
  const [, file, first, last, side] = match;
  const startLine = Number(first);
  const line = Number(last ?? first);
  if (!validPath(file) || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(line) || line < startLine) {
    throw new Error(`Comment ${entry} has an invalid thread path or line range.`);
  }
  return { kind: 'thread', path: file, startLine, line, side: side as Side };
}

function parseDirective(value: string, entry: number): Placement {
  const directive = value.trim();
  if (directive.startsWith('<!-- gh-comment:thread')) return parseThreadDirective(directive, entry);
  if (directive.startsWith('<!-- gh-comment:file')) {
    const file = FILE_DIRECTIVE.exec(directive)?.[1];
    if (!file || !validPath(file)) throw new Error(`Comment ${entry} has an invalid file directive. Use <!-- gh-comment:file path="file" -->.`);
    return { kind: 'file', path: file };
  }
  if (directive.startsWith('<!-- gh-comment:reply')) {
    const raw = REPLY_DIRECTIVE.exec(directive)?.[1];
    const parentId = Number(raw);
    if (!raw || !Number.isSafeInteger(parentId)) throw new Error(`Comment ${entry} has an invalid reply directive. Use <!-- gh-comment:reply id="123456789" -->.`);
    return { kind: 'reply', parentId };
  }
  const event = REVIEW_DIRECTIVE.exec(directive)?.[1];
  if (!event) throw new Error(`Comment ${entry} has an invalid review directive. Use <!-- gh-comment:review event="COMMENT" -->.`);
  return { kind: 'review', event: event as ReviewEvent };
}

function walk(node: Nodes, visit: (node: Nodes) => void) {
  visit(node);
  if ('children' in node) for (const child of node.children) walk(child, visit);
}

function labelEnd(node: LinkNode | Definition, source: string) {
  if (node.type === 'imageReference') {
    if (node.referenceType === 'shortcut') return node.position!.end.offset! - 1;
    // A full/collapsed reference ends in a second bracket pair. Reference
    // identifiers cannot contain unescaped brackets; scan past escaped ones.
    for (let i = node.position!.end.offset! - 2; i > node.position!.start.offset!; i--) {
      if (source[i] !== '[') continue;
      let slashes = 0;
      for (let j = i - 1; source[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) return source.lastIndexOf(']', i - 1);
    }
    throw new Error('Could not locate the Markdown image label.');
  }
  const lastChild = 'children' in node ? node.children.at(-1) : undefined;
  const after = (lastChild ? lastChild.position!.end.offset : undefined) ?? node.position!.start.offset! + 1;
  return source.indexOf(']', after);
}

function destinationRange(node: LinkNode | Definition, source: string): [number, number] {
  if (source[node.position!.start.offset!] === '<') {
    return [node.position!.start.offset! + 1, node.position!.end.offset! - 1];
  }
  let start;
  if (node.type === 'definition') {
    const prefix = /^\[(?:\\.|[^\]\\])*\]:\s*/.exec(source.slice(node.position!.start.offset!, node.position!.end.offset!));
    if (!prefix) throw new Error('Could not locate the Markdown reference definition.');
    start = node.position!.start.offset! + prefix[0].length;
  } else {
    const closing = labelEnd(node, source);
    start = source.indexOf('(', closing) + 1;
  }
  while (/\s/.test(source[start] ?? '') && start < node.position!.end.offset!) start++;
  if (source[start] === '<') return [start + 1, source.indexOf('>', start + 1)];
  let end = start;
  let depth = 0;
  for (; end < node.position!.end.offset!; end++) {
    const char = source[end];
    if (char === '\\') { end++; continue; }
    if (char === '(') depth++;
    else if (char === ')') {
      if (depth === 0) break;
      depth--;
    } else if (/\s/.test(char) && depth === 0) break;
  }
  return [start, end];
}

function inlineReference(node: LinkNode, definition: Definition, source: string, url: string, changes: Edit[]) {
  const start = node.position!.start.offset!;
  const end = labelEnd(node, source) + 1;
  let label = source.slice(start, end);
  for (const edit of changes.filter(edit => edit.start >= start && edit.end <= end).sort((a, b) => b.start - a.start)) {
    label = label.slice(0, edit.start - start) + edit.text + label.slice(edit.end - start);
  }
  const destination = url.replaceAll('<', '%3C').replaceAll('>', '%3E').replaceAll('\n', '%0A');
  const title = definition.title == null ? '' : ` "${definition.title.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  return `${label}(<${destination}>${title})`;
}

export function validateBody(body: string, entry = 1) {
  // HTML comments, including our private marker, do not make a visible comment.
  const visible = fromMarkdown(body).children.some(node => node.type !== 'definition'
    && (node.type !== 'html' || node.value.replace(/<!--[\s\S]*?-->/g, '').trim()));
  if (!visible) {
    throw new Error(`Comment ${entry} is empty. Add text or remove the extra ${SEPARATOR} separator.`);
  }
  if ([...body].length > MAX_COMMENT_LENGTH) {
    throw new Error(`Comment ${entry} exceeds GitHub's ${MAX_COMMENT_LENGTH}-character limit. Split it with ${SEPARATOR}.`);
  }
}

export function hasKeyMarker(body: string, marker: string) {
  const last = fromMarkdown(body).children.at(-1);
  return last?.type === 'html' && last.value.trim() === marker;
}

/** Render source offsets, preserving Markdown and leaving code examples alone. */
export async function renderMarkdown(markdown: string, resolveReference: ReferenceResolver): Promise<CommentEntry[]> {
  const source = markdown.replace(/^\uFEFF/, '');
  const tree = fromMarkdown(source);
  const definitions = new Map<string, Definition>();
  const nodes: LinkNode[] = [];
  const separators = tree.children.filter((node): node is Html => node.type === 'html' && node.value.trim() === SEPARATOR);
  const directives = tree.children.filter((node): node is Html => node.type === 'html' && ENTRY_DIRECTIVE.test(node.value.trim()));
  let directiveNodeCount = 0;
  walk(tree, node => {
    if (node.type === 'html' && ENTRY_DIRECTIVE.test(node.value.trim())) directiveNodeCount++;
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if (node.type === 'link' || node.type === 'linkReference' || node.type === 'imageReference') nodes.push(node);
  });
  if (directiveNodeCount !== directives.length) {
    throw new Error('A gh-comment directive must stand alone at the start of a comment entry. Put literal examples in a code fence.');
  }
  const resolved = new Map<LinkNode, {definition: Definition | undefined; target: string | undefined; url: string | undefined}>();
  // Validate in source order so errors point to the first invalid reference.
  for (const node of nodes) {
    const definition = node.type !== 'link' ? definitions.get(node.identifier) : undefined;
    const target = definition?.url ?? (node.type === 'link' ? node.url : undefined);
    let url;
    if (node.type !== 'imageReference') {
      try {
        const reference = parseLocalReference(target);
        if (reference?.startLine != null) url = (await resolveReference(target!)).url;
      } catch (error) {
        throw new Error(`Markdown line ${node.position!.start.line}: ${errorMessage(error)}`, { cause: error });
      }
    }
    resolved.set(node, { definition, target, url });
  }
  let changes: Edit[] = [];
  // Children first: when a parent link is rewritten, incorporate any image
  // edits inside its label and replace them with a single non-overlapping edit.
  for (const node of nodes.reverse()) {
    const { definition, target, url } = resolved.get(node)!;
    if (definition && (url || separators.length)) {
      // Each posted entry stands alone, so resolve reference-style links across entries.
      const replacement = { start: node.position!.start.offset!, end: node.position!.end.offset!,
        text: inlineReference(node, definition, source, url ?? target!, changes) };
      changes = changes.filter(edit => edit.start < replacement.start || edit.end > replacement.end);
      changes.push(replacement);
    } else if (url) {
      const [start, end] = destinationRange(node, source);
      changes.push({ start, end, text: url });
    }
  }
  // Keep reference definitions readable in raw Markdown without retaining the
  // absolute local paths of links that have just been translated.
  const rewrittenDefinitions = new Set();
  for (const { definition, url } of resolved.values()) {
    if (!definition || !url || rewrittenDefinitions.has(definition)) continue;
    if (!separators.length && nodes.some(node => node.type === 'imageReference' && node.identifier === definition.identifier)) continue;
    const [start, end] = destinationRange(definition, source);
    changes.push({ start, end, text: url });
    rewrittenDefinitions.add(definition);
  }
  const boundaries = [-1, ...separators.map(node => node.position!.start.offset!), source.length];
  const ends = [0, ...separators.map(node => node.position!.end.offset!)];
  const comments: CommentEntry[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = ends[i];
    const end = boundaries[i + 1];
    const entryDirectives = directives.filter(node => node.position!.start.offset! >= start && node.position!.end.offset! <= end);
    if (entryDirectives.length > 1) throw new Error(`Comment ${i + 1} has more than one gh-comment directive.`);
    let placement: Placement | undefined;
    if (entryDirectives.length) {
      const node = entryDirectives[0];
      if (source.slice(start, node.position!.start.offset!).trim()) {
        throw new Error(`Comment ${i + 1} must put its gh-comment directive before the comment body.`);
      }
      placement = parseDirective(node.value, i + 1);
      changes.push({ start: node.position!.start.offset!, end: node.position!.end.offset!, text: '' });
    }
    let body = source.slice(start, end);
    const edits = changes.filter(change => change.start >= start && change.end <= end).sort((a, b) => b.start - a.start);
    for (const change of edits) body = body.slice(0, change.start - start) + change.text + body.slice(change.end - start);
    body = body.trim();
    validateBody(body, i + 1);
    comments.push({ body, ...placement });
  }
  const reviewIndex = comments.findIndex(entry => entry.kind === 'review');
  if (reviewIndex !== -1) {
    if (reviewIndex !== 0 || comments.slice(1).some(entry => entry.kind !== 'thread')) {
      throw new Error('A batch review must start with one review summary followed only by line threads. Put conversation, file, or reply entries in a separate report.');
    }
  }
  return comments;
}

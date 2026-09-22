import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseLocalReference } from './git.js';

export const SEPARATOR = '<!-- gh-comment:next -->';
export const MAX_COMMENT_LENGTH = 65536;

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function labelEnd(node, source) {
  if (node.type === 'imageReference') {
    if (node.referenceType === 'shortcut') return node.position.end.offset - 1;
    // A full/collapsed reference ends in a second bracket pair. Reference
    // identifiers cannot contain unescaped brackets; scan past escaped ones.
    for (let i = node.position.end.offset - 2; i > node.position.start.offset; i--) {
      if (source[i] !== '[') continue;
      let slashes = 0;
      for (let j = i - 1; source[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) return source.lastIndexOf(']', i - 1);
    }
    throw new Error('Could not locate the Markdown image label.');
  }
  const lastChild = node.children?.at(-1);
  const after = lastChild?.position.end.offset ?? node.position.start.offset + 1;
  return source.indexOf(']', after);
}

function destinationRange(node, source) {
  if (source[node.position.start.offset] === '<') {
    return [node.position.start.offset + 1, node.position.end.offset - 1];
  }
  let start;
  if (node.type === 'definition') {
    const prefix = /^\[(?:\\.|[^\]\\])*\]:\s*/.exec(source.slice(node.position.start.offset, node.position.end.offset));
    if (!prefix) throw new Error('Could not locate the Markdown reference definition.');
    start = node.position.start.offset + prefix[0].length;
  } else {
    const closing = labelEnd(node, source);
    start = source.indexOf('(', closing) + 1;
  }
  while (/\s/.test(source[start] ?? '') && start < node.position.end.offset) start++;
  if (source[start] === '<') return [start + 1, source.indexOf('>', start + 1)];
  let end = start;
  let depth = 0;
  for (; end < node.position.end.offset; end++) {
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

function inlineReference(node, definition, source, url, changes) {
  const start = node.position.start.offset;
  const end = labelEnd(node, source) + 1;
  let label = source.slice(start, end);
  for (const edit of changes.filter(edit => edit.start >= start && edit.end <= end).sort((a, b) => b.start - a.start)) {
    label = label.slice(0, edit.start - start) + edit.text + label.slice(edit.end - start);
  }
  const destination = url.replaceAll('<', '%3C').replaceAll('>', '%3E').replaceAll('\n', '%0A');
  const title = definition.title == null ? '' : ` "${definition.title.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  return `${label}(<${destination}>${title})`;
}

export function validateBody(body, entry = 1) {
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

export function hasKeyMarker(body, marker) {
  const last = fromMarkdown(body).children.at(-1);
  return last?.type === 'html' && last.value.trim() === marker;
}

/** Render source offsets, preserving Markdown and leaving code examples alone. */
export async function renderMarkdown(markdown, resolveReference) {
  const source = markdown.replace(/^\uFEFF/, '');
  const tree = fromMarkdown(source);
  const definitions = new Map();
  const nodes = [];
  const separators = tree.children.filter(node => node.type === 'html' && node.value.trim() === SEPARATOR);
  walk(tree, node => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if (node.type === 'link' || node.type === 'linkReference' || node.type === 'imageReference') nodes.push(node);
  });
  const resolved = new Map();
  // Validate in source order so errors point to the first invalid reference.
  for (const node of nodes) {
    const definition = node.type.endsWith('Reference') ? definitions.get(node.identifier) : undefined;
    const target = definition?.url ?? node.url;
    let url;
    if (node.type !== 'imageReference') {
      try {
        const reference = parseLocalReference(target);
        if (reference?.startLine != null) url = (await resolveReference(target)).url;
      } catch (error) {
        throw new Error(`Markdown line ${node.position.start.line}: ${error.message}`, { cause: error });
      }
    }
    resolved.set(node, { definition, target, url });
  }
  let changes = [];
  // Children first: when a parent link is rewritten, incorporate any image
  // edits inside its label and replace them with a single non-overlapping edit.
  for (const node of nodes.reverse()) {
    const { definition, target, url } = resolved.get(node);
    if (definition && (url || separators.length)) {
      // Each posted entry stands alone, so resolve reference-style links across entries.
      const replacement = { start: node.position.start.offset, end: node.position.end.offset,
        text: inlineReference(node, definition, source, url ?? target, changes) };
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
  const boundaries = [-1, ...separators.map(node => node.position.start.offset), source.length];
  const ends = [0, ...separators.map(node => node.position.end.offset)];
  const comments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = ends[i];
    const end = boundaries[i + 1];
    let body = source.slice(start, end);
    const edits = changes.filter(change => change.start >= start && change.end <= end).sort((a, b) => b.start - a.start);
    for (const change of edits) body = body.slice(0, change.start - start) + change.text + body.slice(change.end - start);
    body = body.trim();
    validateBody(body, i + 1);
    comments.push({ body });
  }
  return comments;
}

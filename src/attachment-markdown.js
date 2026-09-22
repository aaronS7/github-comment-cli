import { fromMarkdown } from 'mdast-util-from-markdown';

function labelClose(node, source) {
  if (node.type === 'link' && node.children?.length) {
    return source.indexOf(']', node.children.at(-1).position.end.offset);
  }
  if (node.type === 'image') {
    // Images have an alt string rather than child offsets. Parse the same
    // source as a link so brackets inside code spans cannot end its label.
    const start = node.position.start.offset + 1;
    const link = fromMarkdown(source.slice(start, node.position.end.offset)).children[0]?.children?.[0];
    if (link?.type === 'link') return source.indexOf(']', start + (link.children.at(-1)?.position.end.offset ?? 1));
  }
  let depth = 0;
  for (let index = node.position.start.offset; index < node.position.end.offset; index++) {
    if (source[index] === '\\') { index++; continue; }
    if (source[index] === '[') depth++;
    if (source[index] === ']' && --depth === 0) return index;
  }
  throw new Error('Could not locate attachment label.');
}

function destinationRange(node, source) {
  if (source[node.position.start.offset] === '<') return [node.position.start.offset + 1, node.position.end.offset - 1];
  let start;
  if (node.type === 'definition') {
    const prefix = /^\[(?:\\.|[^\]\\])*\]:\s*/.exec(source.slice(node.position.start.offset, node.position.end.offset));
    if (!prefix) throw new Error('Could not locate attachment definition.');
    start = node.position.start.offset + prefix[0].length;
  } else start = labelClose(node, source) + 2;
  while (/\s/.test(source[start] ?? '') && start < node.position.end.offset) start++;
  if (source[start] === '<') return [start + 1, source.indexOf('>', start + 1)];
  let depth = 0;
  let end = start;
  for (; end < node.position.end.offset; end++) {
    if (source[end] === '\\') { end++; continue; }
    if (source[end] === '(') depth++;
    else if (source[end] === ')') { if (depth === 0) break; depth--; }
    else if (/\s/.test(source[end]) && depth === 0) break;
  }
  return [start, end];
}

export function escapeLabel(text) {
  return String(text).replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]').replace(/[\r\n]/g, ' ');
}

/** Find Markdown media without interpreting code or raw HTML as attachments. */
export function attachmentReferences(source) {
  const tree = fromMarkdown(source);
  const definitions = new Map();
  const nodes = [];
  const visit = (node, parent, insideLink = false) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
      nodes.push({ node, parent, definitionOnly: true });
    }
    if (['image', 'imageReference', 'link', 'linkReference'].includes(node.type)) nodes.push({ node, parent, insideLink });
    if (node.type === 'text' && parent?.type === 'paragraph' && parent.children.length === 1 && /^https?:\/\/\S+$/.test(node.value)) {
      nodes.push({ node, parent, bare: true });
    }
    for (const child of node.children ?? []) visit(child, node, insideLink || node.type === 'link' || node.type === 'linkReference');
  };
  visit(tree);
  return nodes.map(({ node, parent, bare, definitionOnly, insideLink }) => {
    const definition = node.type.endsWith('Reference') ? definitions.get(node.identifier) : undefined;
    return { node, definition, url: bare ? node.value : definition?.url ?? node.url,
      image: node.type.startsWith('image'), bare: Boolean(bare),
      definitionOnly: Boolean(definitionOnly), insideLink: Boolean(insideLink),
      standalone: parent?.type === 'paragraph' && parent.children.length === 1 };
  }).filter(entry => typeof entry.url === 'string');
}

export function rewriteAttachments(source, replacements) {
  const edits = new Map();
  for (const { reference, url, video = false } of replacements) {
    const { node, definition, image, bare, standalone } = reference;
    if (image && video && reference.insideLink) throw new Error('A video attachment cannot be nested inside another link. Use a standalone video or a direct video link.');
    const destination = url.replaceAll('<', '%3C').replaceAll('>', '%3E').replaceAll(' ', '%20');
    if (bare || (image && video)) {
      const text = bare || standalone ? destination : `[${escapeLabel(node.alt || 'Video')}](${destination})`;
      edits.set(node.position.start.offset, { start: node.position.start.offset, end: node.position.end.offset, text });
      if (!definition) continue;
    }
    const [start, end] = destinationRange(definition ?? node, source);
    edits.set(start, { start, end, text: destination });
  }
  // Inner edits first; ordinary destination edits never replace link labels.
  for (const { start, end, text } of [...edits.values()].sort((a, b) => b.start - a.start)) {
    source = source.slice(0, start) + text + source.slice(end);
  }
  return source;
}

import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Root, RootContent, Definition, Image, ImageReference, Link, LinkReference, Text } from 'mdast';

type MarkdownNode = Root | RootContent;
type MediaNode = Definition | Image | ImageReference | Link | LinkReference | Text;

export interface AttachmentReference {
  node: MediaNode;
  definition?: Definition;
  url: string;
  image: boolean;
  bare: boolean;
  definitionOnly: boolean;
  insideLink: boolean;
  standalone: boolean;
}

export interface AttachmentReplacement {
  reference: AttachmentReference;
  url: string;
  video?: boolean;
}

function offsets(node: MarkdownNode): { start: number; end: number } {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) throw new Error('Markdown parser omitted source offsets.');
  return { start, end };
}

function labelClose(node: MediaNode, source: string): number {
  const { start, end } = offsets(node);
  if (node.type === 'link' && node.children.length) {
    return source.indexOf(']', offsets(node.children.at(-1)!).end);
  }
  if (node.type === 'image') {
    // Images have an alt string rather than child offsets. Parse the same
    // source as a link so brackets inside code spans cannot end its label.
    const labelStart = start + 1;
    const rootNode = fromMarkdown(source.slice(labelStart, end)).children[0];
    const link = rootNode && 'children' in rootNode ? rootNode.children[0] : undefined;
    if (link?.type === 'link') return source.indexOf(']', labelStart + (link.children.at(-1)?.position?.end.offset ?? 1));
  }
  let depth = 0;
  for (let index = start; index < end; index++) {
    if (source[index] === '\\') { index++; continue; }
    if (source[index] === '[') depth++;
    if (source[index] === ']' && --depth === 0) return index;
  }
  throw new Error('Could not locate attachment label.');
}

function destinationRange(node: MediaNode, source: string): [number, number] {
  const { start: nodeStart, end: nodeEnd } = offsets(node);
  if (source[nodeStart] === '<') return [nodeStart + 1, nodeEnd - 1];
  let start: number;
  if (node.type === 'definition') {
    const prefix = /^\[(?:\\.|[^\]\\])*\]:\s*/.exec(source.slice(nodeStart, nodeEnd));
    if (!prefix) throw new Error('Could not locate attachment definition.');
    start = nodeStart + prefix[0].length;
  } else start = labelClose(node, source) + 2;
  while (/\s/.test(source[start] ?? '') && start < nodeEnd) start++;
  if (source[start] === '<') return [start + 1, source.indexOf('>', start + 1)];
  let depth = 0;
  let end = start;
  for (; end < nodeEnd; end++) {
    if (source[end] === '\\') { end++; continue; }
    if (source[end] === '(') depth++;
    else if (source[end] === ')') { if (depth === 0) break; depth--; }
    else if (/\s/.test(source[end] ?? '') && depth === 0) break;
  }
  return [start, end];
}

export function escapeLabel(text: string): string {
  return String(text).replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]').replace(/[\r\n]/g, ' ');
}

/** Find Markdown media without interpreting code or raw HTML as attachments. */
export function attachmentReferences(source: string): AttachmentReference[] {
  const tree = fromMarkdown(source);
  const definitions = new Map<string, Definition>();
  const nodes: Array<{ node: MediaNode; parent?: MarkdownNode; bare?: boolean; definitionOnly?: boolean; insideLink?: boolean }> = [];
  const visit = (node: MarkdownNode, parent?: MarkdownNode, insideLink = false): void => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
      nodes.push({ node, parent, definitionOnly: true });
    }
    if (node.type === 'image' || node.type === 'imageReference' || node.type === 'link' || node.type === 'linkReference') {
      nodes.push({ node, parent, insideLink });
    }
    if (node.type === 'text' && parent?.type === 'paragraph' && parent.children.length === 1 && /^https?:\/\/\S+$/.test(node.value)) {
      nodes.push({ node, parent, bare: true });
    }
    if ('children' in node) for (const child of node.children) visit(child, node, insideLink || node.type === 'link' || node.type === 'linkReference');
  };
  visit(tree);
  const references: AttachmentReference[] = [];
  for (const { node, parent, bare, definitionOnly, insideLink } of nodes) {
    const definition = node.type === 'imageReference' || node.type === 'linkReference' ? definitions.get(node.identifier) : undefined;
    const url = bare && node.type === 'text' ? node.value : definition?.url ?? ('url' in node ? node.url : undefined);
    if (typeof url !== 'string') continue;
    references.push({ node, definition, url,
      image: node.type === 'image' || node.type === 'imageReference', bare: Boolean(bare),
      definitionOnly: Boolean(definitionOnly), insideLink: Boolean(insideLink),
      standalone: parent?.type === 'paragraph' && parent.children.length === 1 });
  }
  return references;
}

export function rewriteAttachments(source: string, replacements: AttachmentReplacement[]): string {
  const edits = new Map<number, { start: number; end: number; text: string }>();
  for (const { reference, url, video = false } of replacements) {
    const { node, definition, image, bare, standalone } = reference;
    if (image && video && reference.insideLink) throw new Error('A video attachment cannot be nested inside another link. Use a standalone video or a direct video link.');
    const destination = url.replaceAll('<', '%3C').replaceAll('>', '%3E').replaceAll(' ', '%20');
    if (bare || (image && video)) {
      const text = bare || standalone ? destination : `[${escapeLabel('alt' in node ? node.alt || 'Video' : 'Video')}](${destination})`;
      const { start, end } = offsets(node);
      edits.set(start, { start, end, text });
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

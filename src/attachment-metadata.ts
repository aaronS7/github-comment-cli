import { fromMarkdown } from 'mdast-util-from-markdown';
import { attachmentReferences, rewriteAttachments } from './attachment-markdown.js';
import type { AssetMetadata } from './attachment-types.js';

const PREFIX = '<!-- gh-comment:attachments:';
const KEY = /^<!-- gh-comment:key:[A-Za-z0-9_.-]{1,100} -->$/;
const MIME = /^(?:image\/(?:png|jpeg|gif|webp|svg\+xml)|video\/(?:mp4|quicktime|webm))$/;
type AssetIdentity = Pick<AssetMetadata, 'sha256'> & { contentType: string };

export const validAssetUrl = (value: unknown): value is string => typeof value === 'string'
  && /^https:\/\/github\.com\/user-attachments\/assets\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value);
export const assetKey = (asset: AssetIdentity): string => `${asset.sha256}:${asset.contentType}`;
export const assetPlaceholder = (asset: AssetIdentity): string => `https://gh-comment.invalid/attachments/${asset.sha256}/${encodeURIComponent(asset.contentType)}`;

function isAssetMetadata(value: unknown): value is AssetMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const asset = value as Record<string, unknown>;
  return Object.keys(asset).sort().join() === 'contentType,sha256,url'
    && typeof asset.sha256 === 'string' && typeof asset.contentType === 'string'
    && /^[a-f\d]{64}$/.test(asset.sha256) && MIME.test(asset.contentType) && validAssetUrl(asset.url);
}

export function readAttachmentMetadata(body: string): { body: string; assets: AssetMetadata[] } {
  if (!body.includes(PREFIX)) return { body, assets: [] };
  const nodes = fromMarkdown(body).children;
  const last = nodes.at(-1);
  const node = last?.type === 'html' && KEY.test(last.value.trim()) ? nodes.at(-2) : last;
  if (node?.type !== 'html' || !node.value.startsWith(PREFIX)) return { body, assets: [] };
  const match = /^<!-- gh-comment:attachments:([A-Za-z0-9_-]{1,40000}) -->$/.exec(node.value.trim());
  if (!match) return { body, assets: [] };
  try {
    const bytes = Buffer.from(match[1], 'base64url');
    if (bytes.toString('base64url') !== match[1]) return { body, assets: [] };
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { body, assets: [] };
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || Object.keys(record).sort().join() !== 'assets,v' || !Array.isArray(record.assets)
      || record.assets.length < 1 || record.assets.length > 50) return { body, assets: [] };
    const urls = new Set<string>();
    const keys = new Set<string>();
    const assets: AssetMetadata[] = [];
    for (const asset of record.assets) {
      if (!isAssetMetadata(asset) || urls.has(asset.url) || keys.has(assetKey(asset))) return { body, assets: [] };
      urls.add(asset.url); keys.add(assetKey(asset)); assets.push(asset);
    }
    const clean = body.slice(0, node.position!.start.offset).trimEnd() + body.slice(node.position!.end.offset);
    const referenced = new Set(attachmentReferences(clean).filter(reference => !reference.definitionOnly).map(reference => reference.url));
    // A marker alone must never establish an unrelated cached upload.
    if (assets.some(asset => !referenced.has(asset.url))) return { body, assets: [] };
    return { body: clean, assets };
  } catch { return { body, assets: [] }; }
}

export function attachmentCache(comments: ReadonlyArray<{ body: string }>): Map<string, AssetMetadata> {
  const cache = new Map<string, AssetMetadata>();
  for (const comment of comments) for (const asset of readAttachmentMetadata(comment.body).assets) {
    if (!cache.has(assetKey(asset))) cache.set(assetKey(asset), asset);
  }
  return cache;
}

export function comparisonBody(body: string, cache: Map<string, AssetMetadata> = new Map()): string {
  const parsed = readAttachmentMetadata(body);
  if (!parsed.assets.length && !cache.size) return body;
  const byUrl = new Map([...cache.values(), ...parsed.assets].map(asset => [asset.url, assetPlaceholder(asset)]));
  return rewriteAttachments(parsed.body, attachmentReferences(parsed.body)
    .flatMap(reference => {
      const url = byUrl.get(reference.url);
      return url === undefined ? [] : [{ reference, url }];
    }));
}

export function appendAttachmentMetadata(body: string, assets: AssetMetadata[]): string {
  if (!assets.length) return body;
  const marker = `${PREFIX}${Buffer.from(JSON.stringify({ v: 1, assets })).toString('base64url')} -->`;
  const last = fromMarkdown(body).children.at(-1);
  if (last?.type === 'html' && KEY.test(last.value.trim())) {
    return `${body.slice(0, last.position!.start.offset).trimEnd()}\n\n${marker}\n\n${last.value}`;
  }
  const result = `${body.trimEnd()}\n\n${marker}`;
  const final = fromMarkdown(result).children.at(-1);
  if (final?.type !== 'html' || final.value !== marker) {
    throw new Error('Attachment metadata would be inside an open Markdown block. Close the unfinished code or HTML block.');
  }
  return result;
}

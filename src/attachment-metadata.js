import { fromMarkdown } from 'mdast-util-from-markdown';
import { attachmentReferences, rewriteAttachments } from './attachment-markdown.js';

const PREFIX = '<!-- gh-comment:attachments:';
const KEY = /^<!-- gh-comment:key:[A-Za-z0-9_.-]{1,100} -->$/;
const MIME = /^(?:image\/(?:png|jpeg|gif|webp|svg\+xml)|video\/(?:mp4|quicktime|webm))$/;
export const validAssetUrl = value => typeof value === 'string'
  && /^https:\/\/github\.com\/user-attachments\/assets\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value);
export const assetKey = asset => `${asset.sha256}:${asset.contentType}`;
export const assetPlaceholder = asset => `https://gh-comment.invalid/attachments/${asset.sha256}/${encodeURIComponent(asset.contentType)}`;

export function readAttachmentMetadata(body) {
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
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed.v !== 1 || Object.keys(parsed).sort().join() !== 'assets,v' || !Array.isArray(parsed.assets)
      || parsed.assets.length < 1 || parsed.assets.length > 50) return { body, assets: [] };
    const urls = new Set();
    const keys = new Set();
    for (const asset of parsed.assets) {
      if (!asset || Object.keys(asset).sort().join() !== 'contentType,sha256,url'
        || typeof asset.sha256 !== 'string' || typeof asset.contentType !== 'string'
        || !/^[a-f\d]{64}$/.test(asset.sha256) || !MIME.test(asset.contentType) || !validAssetUrl(asset.url)
        || urls.has(asset.url) || keys.has(assetKey(asset))) return { body, assets: [] };
      urls.add(asset.url); keys.add(assetKey(asset));
    }
    const clean = body.slice(0, node.position.start.offset).trimEnd() + body.slice(node.position.end.offset);
    const referenced = new Set(attachmentReferences(clean).filter(reference => !reference.definitionOnly).map(reference => reference.url));
    // A marker alone must never establish an unrelated cached upload.
    if (parsed.assets.some(asset => !referenced.has(asset.url))) return { body, assets: [] };
    return { body: clean, assets: parsed.assets };
  } catch { return { body, assets: [] }; }
}

export function attachmentCache(comments) {
  const cache = new Map();
  for (const comment of comments) for (const asset of readAttachmentMetadata(comment.body).assets) {
    if (!cache.has(assetKey(asset))) cache.set(assetKey(asset), asset);
  }
  return cache;
}

export function comparisonBody(body, cache = new Map()) {
  const parsed = readAttachmentMetadata(body);
  if (!parsed.assets.length && !cache.size) return body;
  const byUrl = new Map([...cache.values(), ...parsed.assets].map(asset => [asset.url, assetPlaceholder(asset)]));
  return rewriteAttachments(parsed.body, attachmentReferences(parsed.body)
    .filter(reference => byUrl.has(reference.url)).map(reference => ({ reference, url: byUrl.get(reference.url) })));
}

export function appendAttachmentMetadata(body, assets) {
  if (!assets.length) return body;
  const marker = `${PREFIX}${Buffer.from(JSON.stringify({ v: 1, assets })).toString('base64url')} -->`;
  const last = fromMarkdown(body).children.at(-1);
  if (last?.type === 'html' && KEY.test(last.value.trim())) {
    return `${body.slice(0, last.position.start.offset).trimEnd()}\n\n${marker}\n\n${last.value}`;
  }
  const result = `${body.trimEnd()}\n\n${marker}`;
  if (fromMarkdown(result).children.at(-1)?.value !== marker) {
    throw new Error('Attachment metadata would be inside an open Markdown block. Close the unfinished code or HTML block.');
  }
  return result;
}

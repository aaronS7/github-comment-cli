import path from 'node:path';
import { prepareAttachment } from './attachment-data.js';
import type { PreparedAttachment } from './attachment-types.js';
import type { AssetMetadata } from './attachment-types.js';
import { attachmentReferences, rewriteAttachments, escapeLabel } from './attachment-markdown.js';
import type { AttachmentReplacement } from './attachment-markdown.js';
import { assetKey, assetPlaceholder, appendAttachmentMetadata, validAssetUrl } from './attachment-metadata.js';
import { validateBody } from './markdown.js';

const MEDIA = /\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm)$/i;
export interface AttachmentManagerOptions {
  baseDir: string;
  cwd: string;
  explicit?: string[];
  uploadRemote?: boolean;
  allowPrivateNetwork?: boolean;
  offline?: boolean;
  memoryLimitBytes?: number;
}

interface AttachmentResultEntry {
  action: string;
  body?: string;
}

interface AttachmentGithub {
  uploadAttachment(repo: string, asset: PreparedAttachment): Promise<string>;
}

const remote = (source: string): boolean => /^https?:\/\//i.test(source);
const localSource = (source: string): boolean => !source.startsWith('#') && !source.startsWith('//')
  && (!/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('file:') || /^[a-z]:[\\/]/i.test(source));
function localMedia(source: string): boolean {
  if (source.startsWith('#') || source.startsWith('//')) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !source.startsWith('file:') && !/^[a-z]:[\\/]/i.test(source)) return false;
  try { return MEDIA.test(decodeURIComponent(source.startsWith('file:') ? new URL(source).pathname : source)); }
  catch { return false; }
}

function decodeLocalMarkdownSource(source: string, isRemote: boolean): string {
  return isRemote || source.startsWith('file:') ? source : decodeURIComponent(source);
}

/** Immutable snapshots live only for this invocation; committed comment metadata is the cross-run cache. */
export class Attachments {
  assets = new Map<string, PreparedAttachment>();
  pending: Array<{ name: string; action: 'download' }> = [];
  urls = new Map<string, string>();
  uploaded = new Set<string>();
  #sources = new Map<string, PreparedAttachment>();
  #usedMemory = 0;
  readonly options: AttachmentManagerOptions;

  constructor(options: AttachmentManagerOptions) { this.options = options; }
  get active() { return this.assets.size > 0; }

  async #prepare(source: string, baseDir: string): Promise<PreparedAttachment> {
    // URI decoding belongs to Markdown destinations, not explicit shell filenames.
    const sourceKey = remote(source) || source.startsWith('file:') ? source : path.resolve(baseDir, source);
    const known = this.#sources.get(sourceKey);
    if (known) return known;
    const asset = await prepareAttachment(source, {
      baseDir, downloadRemote: Boolean(this.options.uploadRemote), allowPrivateNetwork: Boolean(this.options.allowPrivateNetwork),
      memoryLimitBytes: Math.max(0, (this.options.memoryLimitBytes ?? 8 * 1024 * 1024) - this.#usedMemory),
    });
    const key = assetKey(asset);
    const existing = this.assets.get(key);
    if (existing) {
      await asset.dispose();
      this.#sources.set(sourceKey, existing);
      return existing;
    }
    if (this.assets.size >= 50) { await asset.dispose(); throw new Error('At most 50 distinct attachments can be included in one invocation.'); }
    this.assets.set(key, asset);
    this.#sources.set(sourceKey, asset);
    if (asset.storage === 'memory') this.#usedMemory += asset.size;
    return asset;
  }

  async prepare<T extends { body: string }>(comments: T[]): Promise<T[]> {
    try {
      const bodies = comments.map(entry => entry.body);
      for (let index = 0; index < bodies.length; index++) {
        const replacements: AttachmentReplacement[] = [];
        for (const reference of attachmentReferences(bodies[index])) {
          const isRemote = remote(reference.url);
          const shouldPrepare = localMedia(reference.url)
            || (reference.image && localSource(reference.url))
            || (isRemote && reference.image && this.options.uploadRemote);
          if (reference.bare || reference.definitionOnly || validAssetUrl(reference.url) || !shouldPrepare) continue;
          if (isRemote && this.options.offline) { this.pending.push({ name: 'Remote image', action: 'download' }); continue; }
          const source = decodeLocalMarkdownSource(reference.url, isRemote);
          const asset = await this.#prepare(source, this.options.baseDir);
          replacements.push({ reference, url: assetPlaceholder(asset), video: asset.contentType.startsWith('video/') });
        }
        bodies[index] = rewriteAttachments(bodies[index], replacements);
      }
      for (const source of this.options.explicit ?? []) {
        if (validAssetUrl(source)) {
          if (!bodies.some(body => attachmentReferences(body).some(reference => reference.url === source))) bodies[0] += `\n\n![Attachment](${source})`;
          continue;
        }
        if (remote(source) && !this.options.uploadRemote) throw new Error('Remote --attach URLs require --upload-remote-images.');
        if (remote(source) && this.options.offline) {
          const url = new URL(source);
          if (url.username || url.password) throw new Error('Remote attachment URLs must not contain credentials.');
          bodies[0] += `\n\n![Remote attachment](<${url.href.replaceAll('>', '%3E')}>)`;
          this.pending.push({ name: 'Remote attachment', action: 'download' });
          continue;
        }
        const asset = await this.#prepare(source, this.options.cwd);
        const placeholder = assetPlaceholder(asset);
        if (bodies.some(body => attachmentReferences(body).some(reference => reference.url === placeholder))) continue;
        bodies[0] += asset.contentType.startsWith('video/') ? `\n\n${placeholder}` : `\n\n![${escapeLabel(asset.name)}](${placeholder})`;
      }
      // Splitting a report makes reference images inline and can leave their
      // definitions in another entry. Rewrite those too, without reading or
      // uploading files referenced only by unused definitions.
      for (let index = 0; index < bodies.length; index++) {
        const replacements: AttachmentReplacement[] = [];
        for (const reference of attachmentReferences(bodies[index]).filter(reference => reference.definitionOnly)) {
          let source = reference.url;
          if (!remote(source) && !source.startsWith('file:')) {
            try { source = decodeURIComponent(source); } catch { continue; }
          }
          const key = remote(source) || source.startsWith('file:') ? source : path.resolve(this.options.baseDir, source);
          const asset = this.#sources.get(key);
          if (asset) replacements.push({ reference, url: assetPlaceholder(asset) });
        }
        bodies[index] = rewriteAttachments(bodies[index], replacements);
      }
      return bodies.map((body, index) => { this.validate(body); return { ...comments[index], body }; });
    } catch (error) { await this.dispose(); throw error; }
  }

  used(body: string): PreparedAttachment[] {
    const references = new Set(attachmentReferences(body).filter(reference => !reference.definitionOnly).map(reference => reference.url));
    return [...this.assets.values()].filter(asset => references.has(assetPlaceholder(asset)));
  }

  validate(body: string): void {
    // Reserve room for the final manifest before uploading any bytes. Placeholder
    // URLs are longer than the canonical UUID URLs returned by the upload API.
    const metadata = this.used(body).map(asset => ({ sha256: asset.sha256, contentType: asset.contentType, url: assetPlaceholder(asset) }));
    validateBody(appendAttachmentMetadata(body, metadata));
  }

  setCache(cache: Map<string, AssetMetadata>): void {
    this.urls = new Map([...cache.entries()].map(([key, asset]) => [key, asset.url]));
  }

  describe(entries: AttachmentResultEntry[], { published = false }: { published?: boolean } = {}) {
    const needed = new Set(entries.filter((entry): entry is AttachmentResultEntry & { body: string } =>
      ['created', 'updated'].includes(entry.action) && typeof entry.body === 'string')
      .flatMap(entry => this.used(entry.body).map(assetKey)));
    return [...[...this.assets.values()].map(asset => ({
      sha256: asset.sha256, name: asset.name, contentType: asset.contentType, size: asset.size, storage: asset.storage,
      action: published ? !needed.has(assetKey(asset)) ? 'skipped' : this.uploaded.has(assetKey(asset)) ? 'uploaded' : 'reused'
        : !needed.has(assetKey(asset)) ? 'skip' : this.urls.has(assetKey(asset)) ? 'reuse' : 'upload',
      ...(this.urls.has(assetKey(asset)) ? { url: this.urls.get(assetKey(asset)) } : {}),
    })), ...this.pending];
  }

  hasUploads(entries: AttachmentResultEntry[]): boolean {
    return entries.some(entry => typeof entry.body === 'string' && ['created', 'updated'].includes(entry.action)
      && this.used(entry.body).some(asset => !this.urls.has(assetKey(asset))));
  }

  async uploadNeeded(entries: AttachmentResultEntry[], github: AttachmentGithub, repo: string): Promise<void> {
    for (const entry of entries) {
      if (!['created', 'updated'].includes(entry.action) || typeof entry.body !== 'string') continue;
      for (const asset of this.used(entry.body)) {
        const key = assetKey(asset);
        if (this.urls.has(key)) continue;
        const url = await github.uploadAttachment(repo, asset);
        if (!validAssetUrl(url)) throw new Error('GitHub returned an unexpected attachment URL. The upload may have succeeded; it was not retried.');
        this.urls.set(key, url);
        this.uploaded.add(key);
      }
    }
  }

  materialize(body: string, { preview = false }: { preview?: boolean } = {}): string {
    const used = this.used(body);
    const replacements = new Map([...this.assets.values()].map(asset => [assetPlaceholder(asset), this.urls.get(assetKey(asset))]));
    const result = rewriteAttachments(body, attachmentReferences(body).flatMap(reference => {
      const url = replacements.get(reference.url);
      return url ? [{ reference, url }] : [];
    }));
    if (preview) return result;
    if (used.some(asset => !this.urls.has(assetKey(asset)))) throw new Error('An attachment has no uploaded URL.');
    const metadata: AssetMetadata[] = used.flatMap(asset => {
      const url = this.urls.get(assetKey(asset));
      return url ? [{ sha256: asset.sha256, contentType: asset.contentType, url }] : [];
    });
    return appendAttachmentMetadata(result, metadata);
  }

  async dispose() {
    await Promise.all([...this.assets.values()].map(asset => asset.dispose()));
  }
}

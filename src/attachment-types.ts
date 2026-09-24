export type AttachmentContentType =
  | 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml'
  | 'video/mp4' | 'video/quicktime' | 'video/webm';

export interface AssetMetadata {
  sha256: string;
  contentType: AttachmentContentType;
  url: string;
}

export interface PreparedAttachment {
  readonly name: string;
  readonly contentType: AttachmentContentType;
  readonly size: number;
  readonly sha256: string;
  readonly storage: 'memory' | 'disk';
  openBody(): Buffer<ArrayBufferLike> | import('node:fs').ReadStream;
  dispose(): Promise<void>;
}

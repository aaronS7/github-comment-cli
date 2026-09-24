/** Shapes shared by Markdown parsing, planning, publication, and preview. */
export type Side = 'LEFT' | 'RIGHT';
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
export type DedupeMode = 'off' | 'exact' | 'similar';

export interface Config {
  dedupe: DedupeMode;
  similarityThreshold: number;
}

export interface ConversationEntry {
  body: string;
  kind?: undefined;
}

export interface ThreadEntry {
  kind: 'thread';
  body: string;
  path: string;
  startLine: number;
  line: number;
  side: Side;
}

export interface FileEntry {
  kind: 'file';
  body: string;
  path: string;
}

export interface ReplyEntry {
  kind: 'reply';
  body: string;
  parentId: number;
}

export interface ReviewEntry {
  kind: 'review';
  body: string;
  event: ReviewEvent;
}

export type CommentEntry = ConversationEntry | ThreadEntry | FileEntry | ReplyEntry | ReviewEntry;

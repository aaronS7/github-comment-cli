import type { Attachments } from './attachments.js';
import type { GitHub } from './github.js';
import type { GitHubObject } from './github-types.js';
import type { CommentEntry, DedupeMode, ReviewEvent } from './types.js';
export type PublicationGitHub = Pick<GitHub,
  'getViewer' | 'listComments' | 'listReviewComments' | 'listReviews' | 'getPull'
  | 'createComment' | 'updateComment' | 'createReviewComment' | 'createFileComment' | 'createReviewReply' | 'createReview'
  | 'preflightAttachmentUpload' | 'uploadAttachment'>;

export interface PublicationPlan {
  repo: string;
  pr: number;
  sha: string;
  comments: CommentEntry[];
  marker?: string | undefined;
  settings?: { dedupe: DedupeMode; similarityThreshold: number } | undefined;
  attachments?: Attachments | undefined;
  context: { github: PublicationGitHub };
}
export interface DecisionFields {
  action: 'pending' | 'created' | 'updated' | 'unchanged' | 'skipped';
  operation?: string | undefined;
  id?: number | undefined;
  url?: string | undefined;
  duplicateOf?: number | undefined;
  reason?: string | undefined;
  similarity?: number | undefined;
  reviewId?: number | undefined;
  reviewUrl?: string | undefined;
}
export type PlannedComment = CommentEntry & DecisionFields;
export type PublishedComment = CommentEntry extends infer E ? E extends CommentEntry ? Omit<E, 'body'> & DecisionFields : never : never;
export interface PublicationResult<T = PlannedComment> {
  repo: string;
  pr: number;
  sha: string;
  comments: T[];
  attachments?: ReturnType<Attachments['describe']>;
  writes?: { operation: string; event: ReviewEvent; commentIndexes: number[] }[];
}
export interface PublicationError extends Error { partialResult?: PublicationResult<PublishedComment> }
export type OwnedComment = GitHubObject & {body: string};

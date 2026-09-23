import { compareBodies, fingerprint } from './dedupe.js';
import { hasKeyMarker, validateBody } from './markdown.js';
import { attachmentCache, comparisonBody } from './attachment-metadata.js';

function commentLocation(comment) {
  if (!Number.isSafeInteger(comment?.id) || comment.id <= 0 || typeof comment.html_url !== 'string'
    || !comment.html_url.startsWith('https://github.com/')) {
    throw new Error('GitHub returned an incomplete comment response. Check the PR before retrying; a write may have succeeded.');
  }
  return { id: comment.id, url: comment.html_url };
}

function bestMatch(proposed, candidates, settings, placement) {
  let best;
  for (const candidate of candidates) {
    if (placement !== undefined && candidate.placement !== placement) continue;
    const match = compareBodies(proposed, candidate.fingerprint, {
      mode: settings.dedupe, threshold: settings.similarityThreshold,
    });
    if (!match) continue;
    if (match.reason === 'exact') return { candidate, ...match };
    if (!best || match.similarity > best.similarity) best = { candidate, ...match };
  }
  return best;
}

function threadPlacement(entry) {
  return `${entry.path}\0${entry.side}\0${entry.startLine}\0${entry.line}`;
}

const REVIEW_STATES = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' };

function entryPlacement(entry) {
  if (entry.kind === 'thread') return threadPlacement(entry);
  if (entry.kind === 'file') return entry.path;
  if (entry.kind === 'reply') return String(entry.parentId);
  return undefined;
}

/** Make every decision before the first write; dry-run returns this same plan. */
export async function planPublication(plan) {
  const { github } = plan.context;
  const settings = plan.settings ?? { dedupe: 'exact', similarityThreshold: 0.96 };
  let owned = [];
  let ownedReview = [];
  let ownedReviews = [];
  const hasReviewComments = plan.comments.some(entry => ['thread', 'file', 'reply'].includes(entry.kind));
  const hasConversation = plan.comments.some(entry => !entry.kind);
  const batch = plan.comments[0]?.kind === 'review';
  const needConversation = plan.marker || (settings.dedupe !== 'off' && hasConversation) || plan.attachments?.active;
  const needReview = (hasReviewComments && settings.dedupe !== 'off') || plan.attachments?.active;
  const needReviews = batch && (settings.dedupe !== 'off' || plan.attachments?.active);
  if (needConversation || needReview || needReviews) {
    const viewer = await github.getViewer();
    if (!Number.isSafeInteger(viewer?.id) || viewer.id <= 0) {
      throw new Error('Could not verify the authenticated GitHub account for duplicate detection or --key.');
    }
    if (needConversation) {
      const comments = await github.listComments(plan.repo, plan.pr);
      if (!Array.isArray(comments)) throw new Error('GitHub returned an invalid comment list; publication stopped.');
      owned = comments.filter(comment => comment.user?.id === viewer.id);
    }
    if (needReview) {
      const comments = await github.listReviewComments(plan.repo, plan.pr);
      if (!Array.isArray(comments)) throw new Error('GitHub returned an invalid review-comment list; publication stopped.');
      ownedReview = comments.filter(comment => comment.user?.id === viewer.id);
    }
    if (needReviews) {
      const reviews = await github.listReviews(plan.repo, plan.pr);
      if (!Array.isArray(reviews)) throw new Error('GitHub returned an invalid review list; publication stopped.');
      ownedReviews = reviews.filter(review => review.user?.id === viewer.id)
        .map(review => ({ ...review, body: review.body == null ? '' : review.body }));
    }
    if ([...owned, ...ownedReview, ...ownedReviews].some(comment => typeof comment.body !== 'string')) {
      throw new Error('GitHub omitted a comment body needed for duplicate detection; publication stopped.');
    }
  }
  const cache = attachmentCache([...owned, ...ownedReview, ...ownedReviews]);
  plan.attachments?.setCache(cache);
  const comparable = body => comparisonBody(body, cache);
  const finish = async result => {
    if (plan.attachments?.active) {
      for (const { body } of result.comments) plan.attachments.validate(body);
      if (plan.attachments.hasUploads(result.comments)) await github.preflightAttachmentUpload(plan.repo);
      result.attachments = plan.attachments.describe(result.comments);
    }
    return result;
  };
  const result = { repo: plan.repo, pr: plan.pr, sha: plan.sha, comments: [] };
  if (plan.marker) {
    if (plan.comments.length !== 1) throw new Error('--key requires a single comment.');
    const matches = owned.filter(comment => hasKeyMarker(comment.body, plan.marker));
    if (matches.length > 1) throw new Error('Multiple comments from your account have this key. Remove the duplicate marker before publishing.');
    const existing = matches[0];
    const { body } = plan.comments[0];
    if (!existing) result.comments.push({ body, action: 'created' });
    else {
      const exact = compareBodies(comparable(body), comparable(existing.body), { mode: 'exact' });
      result.comments.push({ body, action: exact ? 'unchanged' : 'updated', ...commentLocation(existing),
        ...(exact ? { reason: 'exact', similarity: 1 } : {}) });
    }
    return finish(result);
  }
  const conversationCandidates = settings.dedupe === 'off' ? [] : owned.map(comment => ({
    comment, fingerprint: fingerprint(comparable(comment.body)),
  }));
  const reviewCandidates = settings.dedupe === 'off' ? [] : ownedReview
    .filter(comment => !comment.in_reply_to_id && comment.subject_type !== 'file' && comment.position !== null
      && Number.isSafeInteger(comment.line) && comment.line > 0
      && (!comment.start_side || comment.start_side === comment.side))
    .map(comment => ({ comment, fingerprint: fingerprint(comparable(comment.body)),
      placement: threadPlacement({ path: comment.path, side: comment.side,
        startLine: comment.start_line ?? comment.line, line: comment.line }) }));
  const filePaths = new Set(plan.comments.filter(entry => entry.kind === 'file').map(entry => entry.path));
  if (settings.dedupe !== 'off' && filePaths.size && ownedReview.some(comment => filePaths.has(comment.path)
    && !comment.in_reply_to_id && !comment.subject_type && comment.line == null && comment.position == null)) {
    throw new Error('GitHub omitted file-level review comment metadata needed for duplicate detection; publication stopped.');
  }
  const fileCandidates = settings.dedupe === 'off' ? [] : ownedReview
    .filter(comment => !comment.in_reply_to_id && comment.subject_type === 'file')
    .map(comment => ({ comment, fingerprint: fingerprint(comparable(comment.body)), placement: comment.path }));
  const replyCandidates = settings.dedupe === 'off' ? [] : ownedReview
    .filter(comment => Number.isSafeInteger(comment.in_reply_to_id))
    .map(comment => ({ comment, fingerprint: fingerprint(comparable(comment.body)), placement: String(comment.in_reply_to_id) }));
  for (const entry of plan.comments) {
    if (entry.kind === 'review') {
      result.comments.push({ ...entry, action: 'pending', operation: 'submitReview' });
      continue;
    }
    const { body } = entry;
    const placement = entryPlacement(entry);
    const candidates = entry.kind === 'thread' ? reviewCandidates
      : entry.kind === 'file' ? fileCandidates
        : entry.kind === 'reply' ? replyCandidates : conversationCandidates;
    const proposed = settings.dedupe === 'off' ? undefined : fingerprint(comparable(body));
    const match = proposed && bestMatch(proposed, candidates, settings, placement);
    if (match) {
      const location = match.candidate.comment ? commentLocation(match.candidate.comment)
        : { duplicateOf: match.candidate.entry };
      result.comments.push({ ...entry, action: 'skipped', reason: match.reason, similarity: match.similarity, ...location });
    } else {
      result.comments.push({ ...entry, action: 'created',
        ...(entry.kind === 'file' ? { operation: 'createFileComment' } : entry.kind === 'reply' ? { operation: 'createReply' }
          : batch && entry.kind === 'thread' ? { operation: 'submitReview' } : {}) });
      // Only an actual pending create becomes a candidate. A skipped, similar
      // proposal is not remote content: similarity is not transitive.
      if (proposed) candidates.push({ fingerprint: proposed, entry: result.comments.length, placement });
    }
  }
  if (batch) {
    const summary = result.comments[0];
    const newThreads = result.comments.some(entry => entry.kind === 'thread' && entry.action === 'created');
    const summarySettings = { ...settings, dedupe: summary.event === 'COMMENT' ? settings.dedupe : 'exact' };
    const candidates = ownedReviews.filter(review => review.state === REVIEW_STATES[summary.event]
      && review.commit_id === plan.sha).map(review => ({ comment: review, fingerprint: fingerprint(comparable(review.body)) }));
    const match = !newThreads && settings.dedupe !== 'off'
      ? bestMatch(fingerprint(comparable(summary.body)), candidates, summarySettings) : undefined;
    result.comments[0] = match
      ? { kind: 'review', event: summary.event, body: summary.body, action: 'skipped', reason: match.reason,
        similarity: match.similarity, ...commentLocation(match.candidate.comment) }
      : { ...summary, action: 'created' };
    result.writes = result.comments[0].action === 'created'
      ? [{ operation: 'submitReview', event: summary.event, commentIndexes: result.comments
        .map((entry, index) => entry.action === 'created' ? index + 1 : undefined).filter(Boolean) }]
      : [];
  }
  return finish(result);
}

function withoutBody(entry) {
  const { body: unusedBody, ...decision } = entry;
  return decision;
}

function reviewCommentMatches(remote, entry, body) {
  return remote.path === entry.path && remote.side === entry.side
    && remote.line === entry.line && (remote.start_line ?? remote.line) === entry.startLine
    && remote.body === body;
}

async function publishBatch(plan, planned, bodies, result) {
  const { github } = plan.context;
  const summary = planned.comments[0];
  if (summary.action === 'skipped') {
    result.comments = planned.comments.map(entry => withoutBody(entry));
    return result;
  }
  const newThreads = planned.comments.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === 'thread' && entry.action === 'created');
  let review;
  try {
    review = await github.createReview(plan.repo, plan.pr, {
      commit_id: plan.sha, body: bodies[0], event: summary.event,
      comments: newThreads.map(({ entry, index }) => ({
        path: entry.path, body: bodies[index], line: entry.line, side: entry.side,
        ...(entry.startLine === entry.line ? {} : { start_line: entry.startLine, start_side: entry.side }),
      })),
    });
    result.comments.push({ ...withoutBody(summary), ...commentLocation(review) });
  } catch (error) {
    const failure = new Error(`Review submission: ${error.message}\nCheck the PR before retrying; the review may have been submitted.`, { cause: error });
    failure.partialResult = result;
    throw failure;
  }
  let publishedThreads = [];
  if (newThreads.length) {
    try {
      publishedThreads = await github.listReviewCommentsForReview(plan.repo, plan.pr, review.id);
      if (!Array.isArray(publishedThreads)) throw new Error('GitHub returned an invalid review-comment list.');
    } catch (error) {
      const failure = new Error(`Review ${result.comments[0].url} was submitted, but its inline comment URLs could not be read: ${error.message}. Check the PR before retrying.`, { cause: error });
      failure.partialResult = result;
      throw failure;
    }
  }
  const used = new Set();
  try {
    for (const [index, entry] of planned.comments.entries()) {
      if (index === 0) continue;
      if (entry.action === 'created') {
        const at = publishedThreads.findIndex((remote, candidate) => !used.has(candidate)
          && reviewCommentMatches(remote, entry, bodies[index]));
        if (at < 0) throw new Error(`Could not match inline comment ${index + 1} to the submitted review.`);
        used.add(at);
        result.comments.push({ ...withoutBody(entry), ...commentLocation(publishedThreads[at]), reviewId: review.id, reviewUrl: result.comments[0].url });
      } else if (entry.duplicateOf !== undefined) {
        const original = result.comments[entry.duplicateOf - 1];
        result.comments.push({ ...withoutBody(entry), id: original.id, url: original.url });
      } else result.comments.push(withoutBody(entry));
    }
  } catch (error) {
    const failure = new Error(`Review ${result.comments[0].url} was submitted, but its inline comments could not all be reconciled: ${error.message}. Check the PR before retrying.`, { cause: error });
    failure.partialResult = result;
    throw failure;
  }
  return result;
}

export async function publish(plan) {
  const { github } = plan.context;
  const planned = await planPublication(plan);
  if (planned.comments.some(entry => ['created', 'updated'].includes(entry.action))) {
    const latest = await github.getPull(plan.repo, plan.pr);
    if (latest.head?.sha !== plan.sha) throw new Error('The PR head changed during validation. Run the command again to use the new commit.');
  }
  const hadUploads = plan.attachments?.hasUploads(planned.comments);
  if (hadUploads) {
    try { await plan.attachments.uploadNeeded(planned.comments, github, plan.repo); }
    catch (error) {
      throw new Error(`${error.message}\nNo comments were written. Completed uploads may remain unattached; uploads are not automatically retried.`, { cause: error });
    }
    const latest = await github.getPull(plan.repo, plan.pr);
    if (latest.head?.sha !== plan.sha) throw new Error('The PR head changed while uploading attachments. No comments were written; uploaded assets may remain unattached.');
  }
  // Finish and validate every body before creating any comments.
  const bodies = planned.comments.map(entry => {
    if (!['created', 'updated'].includes(entry.action)) return entry.body;
    const body = plan.attachments?.active ? plan.attachments.materialize(entry.body) : entry.body;
    validateBody(body);
    return body;
  });
  const result = { repo: plan.repo, pr: plan.pr, sha: plan.sha, comments: [] };
  if (planned.writes) result.writes = planned.writes;
  if (plan.attachments?.active) result.attachments = plan.attachments.describe(planned.comments, { published: true });
  if (plan.comments[0]?.kind === 'review') return publishBatch(plan, planned, bodies, result);
  let written = 0;
  for (const [index, entry] of planned.comments.entries()) {
    try {
      const decision = withoutBody(entry);
      const body = bodies[index];
      if (entry.action === 'created' || entry.action === 'updated') {
        const comment = entry.action === 'updated'
          ? await github.updateComment(plan.repo, entry.id, body)
          : entry.kind === 'thread'
            ? await github.createReviewComment(plan.repo, plan.pr, entry, body, plan.sha)
            : entry.kind === 'file'
              ? await github.createFileComment(plan.repo, plan.pr, entry, body, plan.sha)
              : entry.kind === 'reply'
                ? await github.createReviewReply(plan.repo, plan.pr, entry.parentId, body)
            : await github.createComment(plan.repo, plan.pr, body);
        result.comments.push({ ...decision, ...commentLocation(comment) });
        written++;
      } else if (entry.duplicateOf !== undefined) {
        const original = result.comments[entry.duplicateOf - 1];
        result.comments.push({ ...decision, id: original.id, url: original.url });
      } else result.comments.push(decision);
    } catch (error) {
      const completed = result.comments.length ? `\nPublished ${written} of ${plan.comments.length} entries before the failure; ${result.comments.length - written} entries required no write.\nCompleted entries:\n${result.comments.map((comment, i) => `${i + 1}. ${comment.action}: ${comment.url}`).join('\n')}` : '';
      const hint = plan.marker || plan.settings?.dedupe !== 'off'
        ? '\nCheck the failed entry on GitHub before retrying. A later run will compare against comments that are already present.'
        : '\nDo not rerun the entire file with --dedupe off: it would duplicate comments already posted.';
      const failure = new Error(`Comment ${index + 1}: ${error.message}${completed}${hint}`, { cause: error });
      failure.partialResult = result;
      throw failure;
    }
  }
  return result;
}

/** Keep stdout suitable for piping while decisions and explanations go to stderr. */
export function describeDecision(entry, index, { dryRun = false } = {}) {
  const range = entry.startLine === entry.line ? entry.line : `${entry.startLine}-${entry.line}`;
  const destination = entry.kind === 'thread' ? `review thread at ${entry.path}:${range} (${entry.side})`
    : entry.kind === 'file' ? `file review thread on ${entry.path}`
      : entry.kind === 'reply' ? `reply to review comment ${entry.parentId}`
        : entry.kind === 'review' ? `${entry.event} review` : 'PR comment';
  const target = entry.url ?? (entry.duplicateOf ? `comment ${entry.duplicateOf} in this file` : `a new ${destination}`);
  if (entry.action === 'skipped') {
    const why = entry.reason === 'exact' ? 'exact duplicate, 100% match' : `similar duplicate, ${(entry.similarity * 100).toFixed(2)}% match`;
    return `${dryRun ? 'Would skip' : 'Skipped'} comment ${index + 1} (${why}): ${target}`;
  }
  if (entry.action === 'unchanged') return `Comment ${index + 1} is unchanged: ${target}`;
  return `${dryRun ? `Would ${entry.action === 'created' ? 'create' : 'update'}` : entry.action === 'created' ? 'Created' : 'Updated'} comment ${index + 1}: ${target}`;
}

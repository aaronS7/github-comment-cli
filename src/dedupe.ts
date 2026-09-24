import type { Nodes } from 'mdast';
import type { DedupeMode } from './types.js';
import { createHash } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { comparisonBody } from './attachment-metadata.js';

const KEY_MARKER = /^<!-- gh-comment:key:[A-Za-z0-9_.-]{1,100} -->$/;
const FINGERPRINT = Symbol('gh-comment fingerprint');
export interface Fingerprint {
  readonly [FINGERPRINT]: true;
  readonly hash: string;
  readonly normalized: string;
  readonly protectedSignature: string;
  readonly tokens: readonly string[];
  readonly bigrams: Map<string, number>;
  readonly bigramCount: number;
}
export interface BodyMatch { reason: 'exact' | 'similar'; similarity: number }

const WORDS = /[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*/gu;
// These guards are deliberately bounded. Similarity is a spelling heuristic,
// not a claim that arbitrary sentences have the same meaning.
const CRITICAL_WORDS = new Set(`
  no not never none neither nor cannot without except unless only always
  all any every each before after
  must shall should may might can could will would required optional
  critical high medium low severe severity blocking blocker major minor trivial
  fatal warning warn error informational info urgent emergency
  pass passes passed passing fail fails failed failing failure failures
  safe unsafe secure insecure vulnerable vulnerability vulnerabilities
  success successful regression regressions fixed unfixed resolved unresolved
  enable enabled disable disabled allow allowed deny denied
  true false valid invalid correct incorrect approved rejected accept reject
  important unimportant positive negative encrypted unencrypted
`.trim().split(/\s+/));
const ROOT_FILENAMES = new Set(['Makefile', 'Dockerfile', 'Containerfile', 'LICENSE', 'README', 'Justfile', 'Procfile', 'Gemfile', 'Rakefile']);

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function words(value: string) {
  return (value.match(WORDS) ?? []).map(word => word.toLowerCase().replaceAll('’', "'"));
}

function protectedWords(value: string, tokens: string[]) {
  const data = [];
  // Retain entire path-like and numeric tokens, including case and punctuation.
  // Do not erase commits, anchors, line numbers, versions, percentages or signs.
  for (const token of value.match(/[^\s()[\]{}<>"'`,;!?]+/gu) ?? []) {
    if (/\p{N}/u.test(token) || /[\\/]/.test(token)
      || /^[\p{L}\p{N}_.-]+\.[\p{L}\p{N}_-]+(?:[.#:][^\s]*)?$/u.test(token)
      || /^#[\p{L}\p{N}_-]+$/u.test(token) || /^[a-f\d]{7,64}[.:]?$/i.test(token)
      || ROOT_FILENAMES.has(token.replace(/[.:]+$/g, ''))) data.push(token);
  }
  const critical = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (CRITICAL_WORDS.has(token) || token.endsWith("n't")) {
      critical.push(tokens.slice(Math.max(0, index - 2), Math.min(tokens.length, index + 3)));
    }
  }
  // A comma or comparison operator can reverse the meaning of otherwise
  // identical words. Punctuation must match before a fuzzy comparison.
  const punctuation = (value.match(/[^\p{L}\p{N}\s]/gu) ?? []).join('');
  // CommonMark leaves GFM task states and alert labels inside text nodes.
  const annotations = value.match(/\[(?:[ xX]|!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION))\]/g) ?? [];
  return { data, critical, punctuation, annotations };
}

function canonicalize(node: Nodes, source: string, prose: string[]): {exact: Record<string, unknown>; protectedValue: Record<string, unknown>} {
  const exact: Record<string, unknown> = {};
  const protectedValue: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'position') continue;
    if (key === 'children' && 'children' in node) {
      const children = node.children.map(child => canonicalize(child, source, prose));
      exact.children = children.map(child => child.exact);
      protectedValue.children = children.map(child => child.protectedValue);
    } else if (key === 'value' && node.type === 'text') {
      const value = node.value;
      const raw = source.slice(node.position!.start.offset!, node.position!.end.offset!);
      // CommonMark does not parse GFM tables/tasks/alerts or math. It also
      // decodes escapes and entities before GFM can distinguish literal text
      // from extension syntax. Preserve these spans instead of guessing that
      // changing their spaces or source spelling leaves GitHub rendering intact.
      const extensionSyntax = /\[[ \txX]*\]|\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;
      if (/[|$\\]/.test(raw) || /&(?:#\d+|#x[a-f\d]+|[a-z][a-z\d]+);/i.test(raw)
        || extensionSyntax.test(raw) || extensionSyntax.test(value)) {
        exact.value = raw;
        protectedValue.value = raw;
      } else {
        exact.value = value.replace(/[ \t]+/g, ' ');
        const tokens = words(value);
        for (const token of tokens) prose.push(token);
        protectedValue.value = protectedWords(value, tokens);
      }
    } else if (key === 'value' && node.type === 'inlineCode') {
      // mdast normalizes inline-code whitespace; retain its original spelling
      // instead so changing spaces in code is never treated as duplicate prose.
      exact.value = source.slice(node.position!.start.offset!, node.position!.end.offset!);
      protectedValue.value = exact.value;
    } else {
      exact[key] = value;
      protectedValue[key] = value;
    }
  }
  return { exact, protectedValue };
}

function frequencies(tokens: readonly string[]) {
  const counts = new Map<string, number>();
  for (let index = 1; index < tokens.length; index += 1) {
    // NUL is outside the word-token alphabet, so pairs cannot collide.
    const pair = `${tokens[index - 1]}\0${tokens[index]}`;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/**
 * Compute a reusable Markdown fingerprint. Prose case and line boundaries are
 * retained for exact matching; CRLF and spaces/tabs in ordinary text normalize.
 * A genuine trailing top-level gh-comment key marker is the only metadata
 * ignored. Code, HTML, link destinations and Markdown structure remain present.
 */
export function fingerprint(body: unknown): Fingerprint {
  if (typeof body !== 'string') throw new TypeError('Comment body must be a string.');
  const source = comparisonBody(body).replace(/\r\n/g, '\n');
  const tree = fromMarkdown(source);
  const last = tree.children.at(-1);
  if (last?.type === 'html' && KEY_MARKER.test(last.value.trim())) tree.children.pop();
  const prose: string[] = [];
  const { exact, protectedValue } = canonicalize(tree, source, prose);
  const normalized = JSON.stringify(exact);
  const protectedSignature = JSON.stringify(protectedValue);
  return Object.freeze({
    [FINGERPRINT]: true as const,
    hash: hash(normalized),
    normalized,
    protectedSignature,
    tokens: Object.freeze(prose),
    bigrams: frequencies(prose),
    bigramCount: Math.max(0, prose.length - 1),
  });
}

function isFingerprint(body: unknown): body is Fingerprint {
  // The private symbol can only originate from this module's constructor.
  return !!body && typeof body === 'object' && FINGERPRINT in body && body[FINGERPRINT] === true;
}

function asFingerprint(body: unknown): Fingerprint {
  return isFingerprint(body) ? body : fingerprint(body);
}

/**
 * Return an exact/similar match, or null. Similarity is multiset word-bigram
 * Sørensen–Dice: 2 * shared pair occurrences / total pair occurrences. Matching
 * counts takes O(n) time, without an edit-distance matrix. Protected structures
 * and data must be identical before this optional spelling comparison runs.
 * Pass fingerprints to avoid parsing an existing comment for every new entry.
 */
export function compareBodies(left: string | Fingerprint, right: string | Fingerprint, { mode = 'exact', threshold = 0.96 }: {mode?: DedupeMode; threshold?: number} = {}): BodyMatch | null {
  if (!['exact', 'similar'].includes(mode)) throw new TypeError('Duplicate comparison mode must be exact or similar.');
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new TypeError('Similarity threshold must be greater than 0 and at most 1.');
  }
  const proposed = asFingerprint(left);
  const existing = asFingerprint(right);
  if (proposed.hash === existing.hash && proposed.normalized === existing.normalized) {
    return { reason: 'exact', similarity: 1 };
  }
  if (mode !== 'similar' || proposed.protectedSignature !== existing.protectedSignature) return null;
  const total = proposed.bigramCount + existing.bigramCount;
  let similarity;
  if (total === 0) {
    similarity = proposed.tokens.length === 1 && existing.tokens.length === 1 && proposed.tokens[0] === existing.tokens[0] ? 1 : 0;
  } else {
    let shared = 0;
    const [smaller, larger] = proposed.bigrams.size < existing.bigrams.size
      ? [proposed.bigrams, existing.bigrams] : [existing.bigrams, proposed.bigrams];
    for (const [pair, count] of smaller) shared += Math.min(count, larger.get(pair) ?? 0);
    similarity = 2 * shared / total;
  }
  return similarity >= threshold ? { reason: 'similar', similarity } : null;
}

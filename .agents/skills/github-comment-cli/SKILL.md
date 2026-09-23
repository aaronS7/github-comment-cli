---
name: github-comment-cli
description: Draft, preview, and publish Markdown PR comments, resolvable review threads, replies, and batched reviews with gh-comment. Use when writing PR feedback with source lines, media, duplicate checks, keyed summaries, or GitHub Actions.
metadata:
  author: aaronS7
  repository: github-comment-cli
---

# Work with GitHub PR comments

Use `gh-comment` to turn a Markdown report into PR conversation comments, resolvable diff threads, replies, or one batched review.
It needs Node.js 22 or newer, Git, a checkout containing the PR head for source links, and GitHub authentication to inspect or publish PR comments.

## Prepare the report

1. Confirm the target repository and pull request. Check out the PR head, or ensure each referenced working file matches it.
2. Draft Markdown in a report file. Reference code with ordinary Markdown links such as `[the validation](src/service.js:12-18)` or `[the validation](src/service.js#L12-L18)`. Relative code paths start at the repository root selected by `--cwd`.
3. Put `<!-- gh-comment:next -->` on its own line to begin another comment. Keep it outside code fences. Without a separator, the file produces one comment.
4. Use normal GitHub Markdown in the body. For collapsible content, use a `<details>` block with a `<summary>` ([GitHub's collapsed-section guide](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections)).

For example:

```markdown
## Validation

Please check the [empty-input case](examples/demo.js:3-5).

<details>
<summary>Additional context</summary>

More Markdown can go here.
</details>
```

## Make a comment resolvable

Put an explicit location at the start of an entry:

```markdown
<!-- gh-comment:thread path="src/service.js" line="12-18" side="RIGHT" -->
Please explain why this check belongs here.
```

Use `line="12"` for one line or `line="12-18"` for a range. `RIGHT` uses new-side line numbers for added or context lines; `LEFT` uses old-side line numbers for deleted lines. The path is repository-relative, and the range must stay on one side of one hunk in the current PR diff. The directive is omitted from the posted body. Ordinary source links in the body do not set the location, since one comment may mention several files. Entries without a directive remain conversation comments. GitHub lets the PR author or a repository writer resolve a thread in **Files changed**. `--key` is for conversation comments only.

For a comment on a changed file without choosing a line, start an entry with `<!-- gh-comment:file path="src/service.js" -->`. To continue an existing review conversation, use `<!-- gh-comment:reply id="123456789" -->` with its top-level review comment ID; a reply ID cannot be another reply and must belong to the target PR. These entries can mix with ordinary comments and standalone line threads. Replies do not resolve conversations.

To submit a summary and line threads as one GitHub review, make the **first** entry `<!-- gh-comment:review event="COMMENT" -->` followed only by `gh-comment:thread` entries separated with `gh-comment:next`. An empty thread list is allowed. `APPROVE` and `REQUEST_CHANGES` require those explicit event names and GitHub's permission to submit the decision. Do not infer a decision from the review text. Place file comments, replies, and conversation comments in another report. Fenced `suggestion` blocks inside line-thread bodies pass through as GitHub suggested edits; see [the example report](https://raw.githubusercontent.com/aaronS7/github-comment-cli/main/examples/batch-review.md).

## Add images or videos

- Markdown media paths are relative to the report file's directory. Supported local files are PNG, JPG/JPEG, GIF, WebP, SVG, MP4, MOV, and WebM.
- Use repeated `--attach FILE` flags to append files. Attachment-only comments can read empty Markdown from stdin.
- Remote images remain at their original URLs by default. Add `--upload-remote-images` to download and upload remote Markdown images or remote `--attach` URLs. Use `--allow-private-network` only when the user specifically intends to download from a private network.
- `post --dry-run` validates local attachments and downloads opted-in remote files, but it does not upload assets or create comments. `render` does not download or upload media.
- Native GitHub media uploads need a supported user token with push access. GitHub App installation tokens and the built-in Actions `GITHUB_TOKEN` can post text comments and use hosted media URLs, but cannot perform native uploads.

## Preview before publishing

Install from this repository if `gh-comment` is not available:

```sh
npm ci
npm install --global .
```

Render a report locally, then inspect the publication plan for the target PR:

```sh
gh-comment render review.md --repo owner/repo --pr 123 --cwd /path/to/code-checkout
gh-comment post review.md --repo owner/repo --pr 123 --cwd /path/to/code-checkout --dry-run
```

The report path is relative to the shell's working directory; `--cwd` selects the code checkout used to resolve source references. `render --pr` checks source links against the PR head, thread targets against its diff, file targets against changed paths, and reply parents against that PR. All review/file/reply directives require `--pr` when rendering. Commit and push referenced code first. The default `post --dry-run` checks existing comments and requires authentication.

Use `GH_TOKEN`, `GITHUB_TOKEN`, or an existing `gh auth login` session. The authenticated token determines the comment author and avatar; the CLI cannot assign an arbitrary profile. To post as an installed GitHub App, supply its short-lived installation token as `GH_TOKEN`. App installation tokens can post text comments and use hosted media URLs, but cannot upload native attachments. Never print or commit an App private key or token.

## Choose duplicate behavior

- The default `--dedupe exact` skips exact matches from the authenticated account on this PR and detects duplicate entries within the same report.
- Use `--dedupe similar` to enable near-duplicate detection. Its default threshold is `0.96`; adjust it with `--similarity-threshold 0.98` or set `similarityThreshold` in `.gh-comment.json`. A threshold alone does not enable similar mode.
- Use `--key NAME` for one comment that should be updated on later runs, such as a generated PR summary. A keyed report must contain exactly one comment entry.
- Use `--dedupe off` only when the user explicitly wants duplicate comments.
- File comments deduplicate by path, replies by top-level parent, and line threads by path/side/range. A batched review sends only new line findings. With no new findings, a same-account review on the same head with the same event and body is skipped. Similar matching applies to neutral `COMMENT` summaries, while approval decisions use exact matching only.

Inspect every planned action in the dry-run output. Only publish when the user has requested publication:

```sh
gh-comment post review.md --repo owner/repo --pr 123 --cwd /path/to/code-checkout
```

Pass the same `--key`, dedupe mode, threshold, attachment, and checkout options to the publish command that you used in the dry run.

## GitHub Actions

See the [GitHub Actions example](https://raw.githubusercontent.com/aaronS7/github-comment-cli/main/examples/github-actions.yml) for a workflow using PR event metadata, minimal permissions, serialized runs, and `--key` to update one summary. The example skips fork PRs and Dependabot. Use `pull-requests: write` for text comments. Native media uploads need a supported user token stored in a secret; the built-in `GITHUB_TOKEN` cannot upload them.

## Important behavior

- Code references must point to tracked files, valid lines, and contents matching the selected commit. The CLI refuses references outside the checkout or ones that differ from the PR head.
- Publication validates the report before writing. Multiple comments are separate GitHub requests, so a later network failure can leave earlier entries posted; inspect partial results before retrying.
- Duplicate checks are scoped to comments by the authenticated account on the target PR. They do not compare comments from other accounts or other pull requests.
- GitHub App identity comes from the installation token. To change the avatar, authenticate as the desired account or installed App rather than trying to set it in Markdown.

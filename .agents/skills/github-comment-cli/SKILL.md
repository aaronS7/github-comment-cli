---
name: github-comment-cli
description: Draft, preview, and publish Markdown comments to GitHub pull request conversations with gh-comment. Use when writing PR comments that reference local source lines, include images or videos, avoid duplicate comments, update a keyed summary, or run from GitHub Actions.
compatibility: Requires Node.js 22 or newer, Git, a local checkout containing the PR head for source links, and GitHub authentication to inspect or publish PR comments.
metadata:
  author: aaronS7
  repository: github-comment-cli
---

# Work with GitHub PR comments

Use `gh-comment` to turn a Markdown report into one or more comments in a pull request's conversation. It does not create inline review threads.

## Prepare the report

1. Confirm the target repository and pull request. Use the code checkout that contains the exact PR head commit when adding local source references.
2. Draft Markdown in a report file. Reference code with ordinary Markdown links such as `[the validation](src/service.js:12-18)` or `[the validation](src/service.js#L12-L18)`. Relative code paths start at the repository root selected by `--cwd`.
3. Put `<!-- gh-comment:next -->` on its own line to begin another comment. Keep it outside code fences. Without a separator, the file produces one comment.
4. Use normal GitHub Markdown in the body. For collapsible content, use a `<details>` block with a `<summary>` ([GitHub's collapsed-section guide](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections)). The comments are conversation comments, not inline review comments.

For example:

```markdown
## Validation

Please check the [empty-input case](examples/demo.js:3-5).

<details>
<summary>Additional context</summary>

More Markdown can go here.
</details>
```

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
gh-comment render review.md --cwd /path/to/code-checkout
gh-comment post review.md --repo owner/repo --pr 123 --cwd /path/to/code-checkout --dry-run
```

The report path is relative to the shell's working directory; `--cwd` selects the code checkout used to resolve source references. `render` checks that referenced files and lines exist in the selected commit. With `--pr`, links use the PR head commit and source contents must match it. Commit and push the referenced code first. `post --dry-run` also checks existing comments and therefore requires authentication.

Use `GH_TOKEN`, `GITHUB_TOKEN`, or an existing `gh auth login` session. The authenticated token determines the comment author and avatar; the CLI cannot assign an arbitrary profile. To post as an installed GitHub App, supply its short-lived installation token as `GH_TOKEN`. App installation tokens can post text comments and use hosted media URLs, but cannot upload native attachments. Never print or commit an App private key or token.

## Choose duplicate behavior

- The default `--dedupe exact` skips exact matches from the authenticated account on this PR and detects duplicate entries within the same report.
- Use `--dedupe similar` to enable near-duplicate detection. Its default threshold is `0.96`; adjust it with `--similarity-threshold 0.98` or set `similarityThreshold` in `.gh-comment.json`. A threshold alone does not enable similar mode.
- Use `--key NAME` for one comment that should be updated on later runs, such as a generated PR summary. A keyed report must contain exactly one comment entry.
- Use `--dedupe off` only when the user explicitly wants duplicate comments.

Inspect every planned action in the dry-run output. Only publish when the user has requested publication:

```sh
gh-comment post review.md --repo owner/repo --pr 123
```

Pass the same `--key`, dedupe mode, threshold, attachment, and checkout options to the publish command that you used in the dry run.

## GitHub Actions

See the [GitHub Actions example](https://raw.githubusercontent.com/aaronS7/github-comment-cli/main/examples/github-actions.yml) for a workflow using PR event metadata, minimal permissions, serialized runs, and `--key` to update one summary. The example skips fork PRs and Dependabot. Use `pull-requests: write` for text comments. Native media uploads need a supported user token stored in a secret; the built-in `GITHUB_TOKEN` cannot upload them.

## Important behavior

- Code references must point to tracked files, valid lines, and contents matching the selected commit. The CLI refuses references outside the checkout or ones that differ from the PR head.
- Publication validates the report before writing. Multiple comments are separate GitHub requests, so a later network failure can leave earlier entries posted; inspect partial results before retrying.
- Duplicate checks are scoped to comments by the authenticated account on the target PR. They do not compare comments from other accounts or other pull requests.
- GitHub App identity comes from the installation token. To change the avatar, authenticate as the desired account or installed App rather than trying to set it in Markdown.

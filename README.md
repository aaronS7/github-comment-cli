# github-comment-cli

[Project site](https://aarons7.github.io/github-comment-cli/)

Turn a Markdown file into one or more GitHub pull request comments. Write links to local source lines, include images or videos, preview the result, then publish. Code references become permanent GitHub URLs and local media become native GitHub attachments. Exact duplicate comments are skipped by default; optional similarity checks also skip near duplicates.

```markdown
Please check the [validation](src/service.ts:12-18).
```

becomes:

```markdown
Please check the [validation](https://github.com/owner/repo/blob/COMMIT_SHA/src/service.ts#L12-L18).
```

Entries post to the PR conversation by default. Add a thread directive to an entry when its feedback should appear on a diff line and be resolvable in GitHub.

## Agent resources

The repository includes [`llms.txt`](llms.txt) as a compact map of its documentation and implementation, plus a [GitHub PR comments skill](.agents/skills/github-comment-cli/SKILL.md) with an agent workflow for drafting, previewing, and publishing comments.

## Install from source

Requires Node.js 22 or newer and Git. From this project's directory:

```sh
npm ci
npm install --global .
gh-comment --help
```

The executable is `gh-comment`; the package is `github-comment-cli`. This project has not been published to npm yet.

For authenticated GitHub access, the CLI checks `GH_TOKEN`, then `GITHUB_TOKEN`, then an existing GitHub CLI login (`gh auth token`). If you use GitHub CLI, run `gh auth login` once. Offline rendering needs no token; public PR metadata can be read without one. Publication requires a token with pull request write access to the target repository. See GitHub's [comment API permissions](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment).

### Test locally as a GitHub App

Install the App on the target repository and grant it pull request read/write permission. Run the interactive wrapper from this checkout:

```sh
npm run mint-app-token
```

It prompts for the App Client ID, private-key `.pem` file location, and target repository. The repository default comes from the `origin` remote when available; enter a different repository if needed. The helper writes the short-lived installation token to `.env` as `GH_TOKEN`, preserving other entries and restricting the file to owner-only permissions.

#### Optional setup page for App defaults

The page only saves optional default values for the App Client ID, private-key path, and repository. `npm run mint-app-token` also works on its own and prompts for these values.

For HTTP loopback access, start the server from this checkout and open <http://localhost:4179>. Disable the `Secure` cookie for this HTTP session so browsers including Safari retain it:

```sh
GH_APP_CONFIG_SECURE_COOKIE=false npm run app-config-ui
```

On the host, run `npm run app-config-ui:code` in another terminal to display the access code. The page asks for the App Client ID, private-key path, and default repository, then saves `GH_APP_CLIENT_ID`, `GH_APP_PRIVATE_KEY_FILE`, and `GH_REPO` to this checkout's `.env`. It does not serve `.env` or read the private key contents. After saving, run `npm run mint-app-token` to mint a one-hour `GH_TOKEN`.

For access from another device on your tailnet, start the server with `npm run app-config-ui` (without the HTTP cookie override), keep it bound to localhost, and run `tailscale serve --bg 4179` on the host. Open the HTTPS URL it prints. This keeps the default `Secure` session cookie; see [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) for setup. If you instead bind the server directly to a private Tailscale address and use HTTP, set `GH_APP_CONFIG_HOSTS` to that address and `GH_APP_CONFIG_SECURE_COOKIE=false` before starting it; browsers otherwise reject the `Secure` cookie on an HTTP URL. Use HTTPS for remote access when possible.

Load those credentials into the current shell when you want to use `gh-comment`:

```sh
set -a
. ./.env
set +a
gh-comment post review.md --pr 123 --dry-run
unset GH_TOKEN
```

Remove `--dry-run` to publish as the App bot. The token expires after one hour; run `npm run mint-app-token` again to refresh it. To mint a token and immediately run the CLI, use `npm run gh-comment:app -- post review.md --pr 123 --dry-run`.

Keep the private key outside version control. `.pem` files are ignored by this repository, and the wrapper requires restrictive file permissions on Unix-like systems.

## First comment

In the code repository, create `review.md`:

```markdown
## Review notes

The [validation](src/service.ts:12-18) should reject empty input.
```

Use your actual file path and line numbers, then preview and publish:

```sh
# Offline preview using origin and local HEAD.
gh-comment render review.md

# Open a GitHub-like structural preview in your browser.
gh-comment preview review.md --output review-preview.html

# Preview against the exact head commit of PR 123.
gh-comment render review.md --pr 123
gh-comment preview review.md --pr 123 --output review-preview.html

# Check what will be created or skipped on that PR.
gh-comment post review.md --pr 123 --dry-run

# Publish to that PR.
gh-comment post review.md --pr 123
```

`render` prints the converted Markdown without checking existing comments. `preview` writes a local HTML page showing each entry as a GitHub-like conversation comment, review summary, resolvable line/file thread, or reply. Open the printed file path in a browser. The page renders common GitHub-flavored Markdown, `<details>` folding, suggested-edit blocks, and local images up to 2 MiB each and 8 MiB total. Other local media show labeled placeholders; remote image URLs load in the browser. It is an approximation of GitHub's layout and does not know the eventual posting account or avatar. Without `--output`, it writes to a private temporary file and prints its path.

`preview` never publishes, uploads, downloads remote media, or checks duplicates; use `post --dry-run` for planned actions and duplicate decisions. By default, `post --dry-run` resolves the PR, checks your existing comments, and previews the planned results without posting. `post` reports what it created, updated, left unchanged, or skipped.

The CLI accepts a PR URL and an explicit repository:

```sh
gh-comment post review.md --pr https://github.com/owner/repo/pull/123
gh-comment post review.md --repo owner/repo --pr 123
```

When `--pr` is omitted, `post` uses the GitHub Actions PR event when available, otherwise it looks up the open PR for the current branch. Specify the PR explicitly if detection is ambiguous.

## Local code references

Use ordinary Markdown links with a line number in the destination:

| Markdown | Meaning |
| --- | --- |
| `[check](src/service.ts:12)` | Line 12 |
| `[check](src/service.ts:12-18)` | Lines 12 through 18 |
| `[check](src/service.ts#L12)` | Line 12, GitHub-style anchor |
| `[check](src/service.ts#L12-L18)` | Line range, GitHub-style anchor |
| `[check](/absolute/path/to/repo/src/service.ts:12)` | Absolute path within this checkout |

Relative paths start at the repository root, even when the Markdown file is elsewhere or the command runs in a subdirectory. `--cwd` selects the code repository:

```sh
gh-comment render /tmp/review.md --cwd /path/to/code-repository
```

The input Markdown filename itself is relative to the shell's working directory; `--cwd` changes where code references are resolved.

Code links need line references. Bare paths, inline code, fenced code examples, and ordinary web links stay as written. Local links without line numbers stay as written unless they identify [supported media attachments](#images-and-videos). URL-encode spaces in paths, or put the destination inside angle brackets:

```markdown
See [the check](<src/my service.ts:12>).
```

Files must be tracked in the selected Git commit, line numbers must exist, and referenced file contents must match that commit. Commit and push relevant changes before posting. The tool refuses references that would point to different code, paths outside the checkout, and missing files. It does not translate line numbers through uncommitted edits.

Published links use the PR head commit SHA, so later commits do not move the linked code. Markdown source links include `?plain=1` so GitHub highlights the requested source lines. See GitHub's [permanent code links documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet).

For an offline preview with explicit target metadata:

```sh
gh-comment render review.md --repo owner/repo --sha HEAD
```

`--sha` is for offline rendering. Publication uses the actual PR head, and the selected commit must be available in your local checkout. For a fork PR, the conversation comment belongs to the base repository and code links point to the PR's head repository.

## Images and videos

Local Markdown images and supported local media links are attached automatically. For example, save this as `reports/review.md` with an image at `reports/screenshots/error.png`:

```markdown
## Validation

![The validation message](screenshots/error.png)
```

```sh
gh-comment post reports/review.md --pr 123 --dry-run
gh-comment post reports/review.md --pr 123
```

The uploaded file becomes a native GitHub attachment URL in the comment. It does not need to be tracked in Git. Alt text and surrounding Markdown are preserved. Reference-style images such as `![Validation][screenshot]` with a `[screenshot]: screenshots/error.png` definition work too. Raw HTML such as `<img src="...">` is left as written.

Attachment paths follow these rules:

| Input | Relative paths start at |
| --- | --- |
| Local code line links | The Git repository root selected by `--cwd` |
| Markdown images and media links | The Markdown file's directory |
| Media references read from stdin | The shell's working directory |
| `--attachment-base DIR` | Overrides the base for Markdown media references; `DIR` itself is shell-relative |
| `--attach FILE` | The shell's working directory, including when `--attachment-base` is set |

Append an image or video without editing the Markdown using repeated `--attach` flags:

```sh
gh-comment post review.md --pr 123 --attach screenshots/error.png --attach recordings/demo.mp4
```

An explicitly attached file already referenced by the report is replaced in place. Otherwise it is appended to the first comment entry. Use a descriptive Markdown image label when you want to choose the alt text.

An attachment-only comment can use empty stdin:

```sh
printf '' | gh-comment post - --pr 123 --attach screenshots/error.png
```

For a video player, put a video image reference alone in its paragraph:

```markdown
![](recordings/demo.mp4)
```

It becomes a standalone uploaded URL. Video references within a sentence become links. A video image wrapped inside another Markdown link is rejected; use a standalone video or a direct video link. GitHub documents player placement in its [CLI attachment guide](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli).

Supported formats are PNG, JPG/JPEG, GIF, WebP, SVG, MP4, MOV, and WebM, with at most 50 unique attachments per command. The CLI checks a maximum of 10 MiB per image and 100 MiB per video, following [GitHub CLI's attachment implementation](https://github.com/cli/cli/blob/v2.101.0/internal/attachments/userasset.go). GitHub may apply a lower video limit: free-plan repositories allow 10 MB; eligible paid-plan repositories allow up to 100 MB. See [GitHub's file attachment limits](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files). Other file types are outside this uploader's current scope.

Local attachments must be nonempty regular files with a supported extension; symbolic links are rejected.

Native uploads require push access to the target repository and a supported user token: GitHub CLI OAuth login, a classic PAT, or a fine-grained PAT. GitHub App tokens, including the built-in Actions `GITHUB_TOKEN`, cannot perform these uploads. Such tokens can still post comments that use already-hosted image URLs. This follows [GitHub CLI's upload authentication checks](https://github.com/cli/cli/blob/v2.101.0/internal/attachments/client.go).

Remote images stay at their original URLs unless you opt into downloading and attaching them:

```sh
gh-comment post review.md --pr 123 --upload-remote-images
gh-comment post review.md --pr 123 --upload-remote-images --attach https://images.example/demo.png
```

Canonical `https://github.com/user-attachments/assets/...` URLs are reused. The remote option accepts public HTTP(S) sources by default. To authorize loopback or private-network sources too, supply both flags:

```sh
gh-comment post review.md --pr 123 --upload-remote-images --allow-private-network
```

Remote downloads allow up to five redirects within a 30-second deadline. Their response media type and file signature must agree with the file type; a URL without a filename extension needs a supported response media type.

`post --dry-run` reads and validates local files and downloads opted-in remote files, but uploads nothing and writes no comments. `render` and `preview` never download remote attachments; they leave them pending. The memory threshold defaults to 8 MiB in total across attachment snapshots and can be set with `--attachment-memory-limit 4`. It must be greater than 0 and at most 100 MiB, representing a whole number of bytes. Once that budget is exhausted, additional snapshots spill into private temporary files that are cleaned up when the command finishes. Streaming buffers and Node.js runtime memory are additional to this snapshot budget. Attachment and network options are CLI-only and cannot be enabled in `.gh-comment.json`.

Successfully posted comments retain hidden attachment hashes and asset URLs. Later runs by the same authenticated account on the same PR can reuse the uploaded bytes across machines. Skipped comments do not trigger another upload. Uploads and comment creation are separate operations: a failure after an upload can leave an asset that is not attached to a posted comment.

See [examples/attachments.md](examples/attachments.md) and its small [SVG illustration](examples/media/validation.svg) for a complete local example.

## Multiple comments

A file normally produces one comment. Put `<!-- gh-comment:next -->` on its own line to start another:

```markdown
## Validation

Please check the [empty input case](src/service.ts:12).

<!-- gh-comment:next -->

## Error handling

Could the [fallback](src/service.ts:30-35) include the request ID?
```

Entries post in file order. Normal Markdown horizontal rules (`---`) remain inside their comment. Separators inside code blocks are examples rather than comment boundaries. See [examples/review.md](examples/review.md) for a complete sample.

All entries and references are validated before publication begins. Entries outside an opt-in batch review use separate GitHub requests: if a later request fails, earlier comments can already exist. Review the reported results before rerunning, especially when duplicate checks are disabled.

## Resolvable review threads

Start an entry with a thread directive to attach it to a line or contiguous range in the current PR diff:

```markdown
<!-- gh-comment:thread path="src/service.ts" line="12-18" side="RIGHT" -->
Please clarify why this validation happens here.

<!-- gh-comment:next -->

The rest of the change looks good.
```

Use `line="12"` for one line or `line="12-18"` for a range. `RIGHT` uses new-side line numbers for added or context lines; `LEFT` uses old-side line numbers for deleted lines. The path starts at the repository root. The directive is removed from the published body. A normal source link in the body supplies context but does not choose the thread's location. Entries without a directive remain PR conversation comments, and both kinds can appear in one report.

Thread targets must name a changed file and lines present together on one side of one hunk in the current PR diff. Missing, stale, or unavailable diff targets fail before publication; the CLI does not turn them into conversation comments. Use `render review.md --pr 123`, `preview review.md --pr 123`, or `post review.md --pr 123 --dry-run` to check placement. Offline previews cannot validate a thread. GitHub lets the PR author or someone with repository write access resolve the resulting conversation in **Files changed**. Existing conversation comments cannot be converted into review threads.

Duplicate checks compare review comments with the same path, side, and line range separately from conversation comments. An exact match to an existing resolved thread is skipped without reopening it. `--key` applies only to conversation comments. Standalone review threads post one at a time, so inspect partial results before retrying after a network failure. See GitHub's [review-comment API](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request) and [resolution guide](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/commenting-on-a-pull-request#resolving-conversations).

## Batch reviews, file comments, and replies

Start a report with a review directive to submit its summary and following line threads as **one GitHub review**:

````markdown
<!-- gh-comment:review event="COMMENT" -->
The change is close. I have two inline suggestions.

<!-- gh-comment:next -->

<!-- gh-comment:thread path="src/service.ts" line="12" side="RIGHT" -->
Please handle the empty value here.

<!-- gh-comment:next -->

<!-- gh-comment:thread path="src/service.ts" line="18-20" side="RIGHT" -->
This can be simplified:

```suggestion
return value;
```
````

The first entry is the review body. Only line-thread entries may follow it in the same report. A summary without line threads is also valid. `COMMENT` submits a neutral review. `APPROVE` and `REQUEST_CHANGES` are available only when you explicitly write those event names; GitHub applies its normal review permissions, including restrictions on approving your own PR. The CLI never infers a review decision from the wording of the summary. A fenced `suggestion` block is ordinary GitHub review Markdown and is preserved in the inline body.

For feedback about a changed file without a suitable line, use a file-level review comment. To continue an existing review conversation, reply to its top-level review comment ID:

```markdown
<!-- gh-comment:file path="src/service.ts" -->
Please describe the file's overall responsibility.

<!-- gh-comment:next -->

<!-- gh-comment:reply id="123456789" -->
Thanks, that addresses my concern.
```

File paths must be changed by the PR; a file-level comment does not need a readable diff patch or an invented line number. A reply can target another person's top-level line or file comment on the same PR, but it cannot target another reply. Replies do not resolve or reopen threads. File comments and replies can mix with ordinary entries in a report **without** a review summary directive. Put them in a separate report when posting a batch review.

All these directives must be standalone at the start of their entry. Their placement metadata is removed from the posted body. Use `render report.md --pr 123` or `preview report.md --pr 123` to validate targets without writing; these commands require `--pr` for any review, file, or reply directive. `--key` remains limited to a single PR conversation comment.

The default duplicate check scopes file comments to the same changed path and replies to the same parent ID; it does not compare them with conversation or line comments. For batched reviews, existing inline findings are omitted from the review request. With no new findings, a repeated summary or decision from the same account on the same PR head is skipped. New findings still submit one review even if the summary text repeats. `--dedupe similar` applies to neutral `COMMENT` summaries at the configured threshold; `APPROVE` and `REQUEST_CHANGES` summaries use exact matching. A new PR head can receive a new review. As with other posts, concurrent runs can race, and a lost response can mean GitHub accepted the review; inspect the PR before retrying.

See [examples/batch-review.md](examples/batch-review.md) for a complete report. GitHub documents the [review API](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request), [file review comments](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request), and [review replies](https://docs.github.com/en/rest/pulls/comments#create-a-reply-for-a-review-comment).

## Skip duplicate comments

The default `--dedupe exact` checks comments from the authenticated account on the target PR and skips matching content. It also checks earlier entries in the same Markdown file. A comment posted by another account does not suppress yours, and comments on other PRs are not considered.

Exact comparison preserves parsed Markdown structure, case, and line breaks while normalizing CRLF line endings and runs of spaces or tabs in ordinary prose. Outer blank space and a valid final `gh-comment` key marker do not make otherwise identical content different. Code, HTML, link destinations, tables, and math retain their significant content and whitespace.

For optional near-duplicate checks, enable `similar` mode. The default threshold is 0.96, meaning at least 96% similarity:

```sh
gh-comment post review.md --pr 123 --dedupe similar
gh-comment post review.md --pr 123 --dedupe similar --similarity-threshold 0.98
```

The similarity percentage is a lexical score based on shared adjacent word pairs in prose. Conservative guards check code, link targets, file paths, numbers, punctuation, and critical wording before allowing a near match. Changes to these details remain eligible for publication even when the surrounding text looks nearly identical. Similarity is a heuristic; use the dry run to inspect which comments it would skip.

Comparison happens after local links become GitHub URLs. A new PR head changes those commit URLs, so an otherwise repeated report can produce new comments. Use `--key` for a report that should be updated across commits.

To intentionally post another copy, turn checks off:

```sh
gh-comment post review.md --pr 123 --dedupe off
```

Preview the decisions before publishing:

```sh
gh-comment post review.md --pr 123 --dedupe similar --dry-run
gh-comment post review.md --pr 123 --dedupe similar --dry-run --json
```

Skipped entries report an `exact` or `similar` reason and a similarity score from 0 to 1. A match to a published comment includes its URL. A match to an earlier entry in the same input identifies that entry with a one-based `duplicateOf` index.

Duplicate checks use authenticated identity, so the default `post --dry-run` needs authentication too. `render`, including `render --pr`, only formats the report and does not check for duplicates. Simultaneous publishers can both observe that a comment is missing; serialize jobs for the same PR when repeated publication must be avoided.

## Configuration

Place `.gh-comment.json` in the code repository root to set defaults:

```json
{
  "dedupe": "similar",
  "similarityThreshold": 0.96
}
```

Start from [examples/.gh-comment.json.example](examples/.gh-comment.json.example). Without a configuration file, the defaults are `dedupe: "exact"` and `similarityThreshold: 0.96`. The threshold only affects `similar` mode; setting a threshold does not enable that mode.

The automatic file is read from the Git root selected by `--cwd`, or from that directory itself if it is outside a Git checkout. To select a different file:

```sh
gh-comment post review.md --pr 123 --config /path/to/comment-settings.json
```

An explicit relative `--config` path starts at the shell's working directory. CLI flags override configuration values, which override built-in defaults. Only `dedupe` and `similarityThreshold` are accepted. The mode must be `off`, `exact`, or `similar`; the threshold must be a JSON number greater than 0 and at most 1. Unknown settings, invalid JSON, invalid values, and missing explicitly selected files fail before GitHub requests. Keep authentication in environment variables or your GitHub CLI login.

## Update a recurring comment

Use a stable key for a report that should occupy one comment across runs:

```sh
gh-comment post summary.md --pr 123 --key build-summary
```

The first run creates the comment. Later runs with the same key update the matching comment authored by the authenticated account; matching content leaves the comment unchanged. A keyed report with changed content is updated even in `similar` mode, so its requested changes are retained. A new key creates its own comment. Unkeyed publication can skip a duplicate of a keyed comment, but never edits it.

Keep the same key and account for the same report on a PR. Keys contain 1–100 letters, numbers, dots, underscores, or hyphens. Keys apply to a single comment, so they cannot be combined with a file that has multiple entries. Concurrent invocations can race to create a comment; serialize runs for a given PR and key.

The key is stored in a hidden HTML comment. `render --key` and `post --dry-run --key` include that marker in their output too.

## Input and output for scripts

Use `-` to read Markdown from stdin:

```sh
cat review.md | gh-comment render - --repo owner/repo
gh-comment post - --pr 123 < review.md
```

Add `--json` for machine-readable output. Rendering returns target metadata and the final comment bodies:

```json
{
  "repo": "owner/repo",
  "pr": 123,
  "sha": "COMMIT_SHA",
  "comments": [{ "body": "Converted Markdown" }]
}
```

Offline rendering uses `"pr": null`. Publication and `post --dry-run` include an action for every entry: `created`, `updated`, `unchanged`, or `skipped`. Known comments include their ID and URL; skipped entries also include the reason and similarity score. A dry run includes the planned comment bodies, and an entry awaiting creation has no published URL yet.

Thread entries include `kind: "thread"`, `path`, `startLine`, `line`, and `side` in JSON. New entry types include `kind: "review"` with `event`, `kind: "file"` with `path`, or `kind: "reply"` with `parentId`. Batch dry runs add a `writes` array identifying the one review request and its included entry indexes. Published inline comments include their review ID and URL. Conversation entries keep their existing shape, without a `kind` field.

| Action | Meaning |
| --- | --- |
| `created` | Create a PR comment, reply, or review |
| `updated` | Replace the contents of the existing comment with this key |
| `unchanged` | The comment with this key already matches |
| `skipped` | An existing own comment or earlier input entry matches |

Without `--json`, dry-run Markdown goes to stdout and decisions go to stderr. JSON output goes to stdout, with diagnostics on stderr. Exit status is 0 on success (including when everything is skipped), 1 for an operational failure, and 2 for invalid CLI arguments.

Attachment plans include an `attachments` array. Each prepared attachment identifies its SHA-256 hash, filename, media type, size, snapshot storage, and planned action (`upload`, `reuse`, or `skip`); a reused asset includes its URL. Completed publication uses `uploaded`, `reused`, or `skipped`. Preview bodies use placeholders for files that have not been uploaded. Local filesystem paths and private download URL queries are omitted from attachment metadata. Offline previews can also include an undownloaded remote entry with `action: "download"`; its size and hash are still unknown.

## GitHub Actions

The CLI already accepts `GITHUB_TOKEN` and PR event metadata. [examples/github-actions.yml](examples/github-actions.yml) demonstrates a recurring comment from this repository's source checkout; it is an example, not an enabled publishing workflow. Once the CLI is published, the installation step can use a pinned package release from another repository.

For new native attachments, use a supported user token with push access through a secret such as `GH_TOKEN: ${{ secrets.COMMENT_UPLOAD_TOKEN }}`. The built-in Actions token remains suitable for text comments and already-hosted media; it does not support native asset uploads. Attachment reuse metadata in posted comments works across separate runners.

The example:

- Checks out `github.event.pull_request.head.sha` so local line numbers match the PR head.
- Grants `contents: read` and `pull-requests: write`.
- Uses `--key` and workflow concurrency to update one comment per PR.
- Runs publication for same-repository PRs and skips Dependabot.

Fork and Dependabot `pull_request` workflows normally receive a read-only token and cannot publish comments. See GitHub's [workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions) and [pull request event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request). Supporting publication from untrusted fork jobs needs a separate trusted publication workflow.

## Development

```sh
npm ci
npm run check
npm test
```

Tests run locally without creating GitHub comments. CI runs the suite on Node.js 22 and 24. Example report files reference [examples/demo.js](examples/demo.js); once this repository has a commit, they can be previewed with an explicit `--repo owner/repo` even without a GitHub remote.

Current scope is GitHub.com PR conversation comments, resolvable line and file threads, replies, batched reviews with explicit review decisions, Markdown source links, native image/video attachments, multiple entries, duplicate checks, and one-comment conversation updates. Resolving threads, issue-specific commands, and a packaged GitHub Action remain outside this interface.

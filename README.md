# Manx Papers content

Blog posts for [Manx Papers](https://beta.manxpapers.com/blog), Control #244. This repository holds
**content only**: posts and their images. Merging to `main` publishes them. There's no site build,
no Beta step and no code release.

## How publishing works
1. **Write.** A post is drafted, often with AI help using the Manx Papers MCP for research, and
   opened as a **pull request** here. The AI only ever opens pull requests.
2. **Check.** The pull request runs the same rules the website serves posts with:
   - the front matter must be valid;
   - the text must be safe;
   - every image the post shows must be in its folder;
   - at least one claim must link to an archive page (`/read/…` or `/search?view=…`).
3. **Review and merge.** The owner reviews the pull request and merges it. **Merging is publishing.**
4. **Publish.** The workflow copies the posts to the content store, the R2 bucket `manxpapers-content`
   under `blog/`. The website reads that store on every request.
5. **Dates.** A post with a future `date` is hidden from the blog index, RSS and sitemap until 00:00
   Isle of Man time on that date. Before then it opens by its direct address (`/blog/<file-name>`),
   marked "Scheduled", so it can be checked in place.
6. **Undo.** Revert the merge. The next publish removes the post from the store.

Nothing here holds or calls an AI provider.

## Writing a post
- **Start from the template.** Copy `templates/post.md` to `posts/<file-name>.md`. The file name is
  the post's address:
  - it uses lower-case words joined by hyphens, for example `posts/laxey-wheel.md` → `/blog/laxey-wheel`;
  - don't rename a post once it's published.
- **Images** go in `images/<file-name>/`:
  - `.jpg`, `.png` or `.webp`, up to 5 MB each;
  - every image needs alt text.
  - Archive page images (`/media/page/…`) aren't allowed in posts yet: their reuse rights are still
    open on Control #244. The check refuses them with a clear message.
- **Every factual claim links to the archive page it comes from**: `[the report](/read/IME/IME-1854-09-29/3)`,
  or a View Article link copied from the address bar (`/search?view=…`). List the main pages under
  `sources`.
- **The AI line.** Posts show "Researched with AI assistance, checked by the editor." Set
  `ai_assisted: false` only for a post written without AI.
- **Markdown** is plain:
  - headings from `##` (the title is the page's only top-level heading);
  - paragraphs, **bold**, *italic*, links, lists and `>` quotes;
  - an image on its own line: `![alt](file.jpg "caption")`.
  - Quote any front-matter text that contains ` #`, for example `title: "Issue #5"`.
  - Raw HTML isn't allowed.

### Front matter
| Field | Required | Notes |
|---|---|---|
| `title` | yes | At most 120 characters |
| `date` | yes | `YYYY-MM-DD`, when the post is listed |
| `summary` | yes | At most 300 characters. Used on the index, in link previews, search results and RSS. |
| `sources` | yes | One or more `/read/…` or `/search?view=…` paths, optionally `{url, label}` |
| `image`, `image_alt` | together | Share image in `images/<file-name>/`. The site's social card is the default. |
| `updated` | no | On or after `date` |
| `tags` | no | Up to 12 |
| `author` | no | Default "Manx Papers" |
| `ai_assisted` | no | Default `true` |

Check locally with `node scripts/validate.mjs`. It needs Node 22 or later and no installs. Run the
tests with `node --test tests/*.test.mjs`.

## Repository setup (owner)
- **Environment `blog-publish`** (deployment branches: `main` only) holds the secrets
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `CF_ACCOUNT_ID`; they are not repository secrets.
  - The token is an R2 API token limited to the `manxpapers-content` bucket, with Object Read & Write.
  - Its expiry is on the Control #242 calendar.
  - If a secret is missing, the publish step fails before uploading anything and names the missing
    secret.
- **The website side** is web's `BLOG` R2 binding to the same bucket (read-only use).

## The rules are the website's own
`vendor/web/` holds unchanged copies of the Web Worker's `blog.mjs`, `markdown.mjs`, `proxy.mjs` and
`security.mjs`, pinned by hash in `vendor/web/VENDOR.json`. When those change in
`Manx-Papers/web`:
1. copy all four again;
2. update the commit and hashes;
3. run the tests.

Web's `test/blog-vendor.test.mjs` pins the same hashes, so a web change to these files fails web CI
until this copy is updated. The current copy is from web#179 (not yet merged); it is re-vendored from
web `main` when the blog code merges there.

## Publishing safeguards
- `main` is protected: changes arrive only by pull request with the owner's approval and a passing
  `content` check.
- Checking and publishing are separate jobs. Publishing runs in the `blog-publish` Environment,
  which only `main` can use, so no pull-request run can reach the content-store secrets.
- Every commit to `main` starts a run. A run publishes only if its commit is still the tip of
  `main`. Re-running an old run, or a run overtaken by a newer merge, publishes nothing and shows a
  warning (the newer commit's run publishes), so the store is never rolled back. If a warning says
  nothing published and no newer run did, run the workflow manually on `main`.

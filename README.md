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
   - at least one claim must link to the archive (an Article, `/search?view=…`, or a page, `/read/…`);
   - a `sources` entry without a label is a warning, not an error.
3. **Review and merge.** The owner reviews the pull request and merges it. **Merging is publishing.**
4. **Publish.** The workflow copies the posts to the content store, the R2 bucket `manxpapers-content`
   under `blog/`. The website reads that store on every request.
5. **Dates.** A post with a future `date` is hidden from the blog index, RSS and sitemap until 00:00
   Isle of Man time on that date. Before then it opens by its direct address (`/blog/<file-name>`),
   marked "Scheduled", so it can be checked in place.
6. **Undo.** Revert the merge. The next publish removes the post from the store.

Nothing here holds or calls an AI provider.

## Writing a post
The **[blog-writer instructions](BLOG-WRITER-PROMPT.md)** are the owner's research, editorial and drafting
requirements for posts: the prompt the Manx Papers Blog plugin uses. They live here so that anyone with
access to this repository can read and update them; Control #244 points here. Where they and the
rules below disagree, the rules below (and `node scripts/validate.mjs`) decide whether a post is accepted.

- **Start from the template.** Copy `templates/post.md` to `posts/<file-name>.md`. The file name is
  the post's address:
  - it uses lower-case words joined by hyphens, for example `posts/laxey-wheel.md` → `/blog/laxey-wheel`;
  - don't rename a post once it's published.
- **Clippings from the archive.** Posts show newspaper clippings by naming the Article; showing them
  is the main reason for the blog. Nothing is copied: the site draws the clipping from the page scan
  each time the post is read (web#183).
  - Put the clipping on a line of its own: `![` + its headline in a few words + `](article:` + the
    Item ID + `)`, with an optional caption in quotes:

    ```markdown
    ![Halt sign summons](article:IMT/IMT-1938-10-08/0004/record/231 "A motorist is fined.")
    ```

  - The Item ID is the part of the Article's copy-link address after `/items/`. Pasting the whole
    address after `article:` also works; the check stores it as the Item ID.
  - The site shows only the Article's own blocks, masked from the page, so nothing from the stories
    around it shows. A story that continues at the top of the next column is shown as its pieces,
    one under another, in reading order.
  - An Article on two or more pages shows its first part. Add `?page=N` to show another page, for
    example `article:IMT/IMT-1938-10-08/0004/record/231?page=4`.
  - A picture (a Picture Item) shows the picture and its caption only, not the article beside it.
  - Up to 12 clippings a post; not inside a `>` quote. Archive page images (`/media/…`) are refused:
    use a clipping.
  - **Every clipping must work without seeing it.** The site adds the paper and date to the alt
    text, for example `Clipping: "Halt sign summons", Isle of Man Times, 8 October 1938`, so give
    only the headline. Don't paste the article into it. Under the clipping the site shows "Read the
    text", the Article's text from the archive, for screen readers and anyone who finds old print
    hard to read.
    - Check that text on the preview. If the automatic reading has obvious mistakes, give a
      corrected version straight after the clipping line, between `::: text` and `:::`:

      ```markdown
      ![Halt sign summons](article:IMT/IMT-1938-10-08/0004/record/231)
      ::: text
      HALT SIGN SUMMONS.

      A motorist's explanation that he did not see a "halt" sign…
      :::
      ```

    - A clipping that is mainly a picture, an advert or a photograph has little useful text. Give
      a fuller description of what it shows instead, between `::: description` and `:::`.
    - If the archive can't be reached when the post is read, the site says the clipping can't be
      shown just now and keeps the caption, a View article link and any text you gave.
- **Other pictures** (modern photos, postcards and so on) go in `images/<file-name>/`:
  - `.jpg`, `.png` or `.webp`, up to 5 MB each;
  - every image needs alt text, and can have a caption.
- **Link to Articles, not pages.** Every factual claim links to the archive, and the link should be
  the **Article** it comes from. Press the Article's copy-link button (on its search result or in
  View Article) and paste the address, for example
  `[the Examiner asked](https://beta.manxpapers.com/items/IME/IME-1946-07-05/0001/record/172)`.
  - The check accepts the address as pasted, from Beta or the live site, and stores it as the
    site's own path, `/search?view=IME%2FIME-1946-07-05%2F0001%2Frecord%2F172`. Typing that path
    works too.
  - An Article link opens the story itself, even when it continues on another page.
  - Use a page link (`/read/IME/IME-1946-07-05/1`) only when the point is the whole page, such as
    its layout or everything printed on it.
  - The same applies to links in the text and to `sources`.
- **Sources.** List the Articles the post relies on under `sources`. Give every entry a `url` and a
  readable `label` in the form "Paper, date: headline":
  ```yaml
  sources:
    - url: https://beta.manxpapers.com/items/IME/IME-1946-07-05/0001/record/172
      label: "Isle of Man Examiner, 5 July 1946: Do We Still Offer a Magic Holiday Isle?"
  ```
  Without a label, an Article shows its address and a page shows only "IME, 5 July 1946, page 1",
  not the headline, so the check warns about any entry without one.
- **The AI line.** Posts show "Written with AI assistance." Set
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
| `sources` | yes | One or more `{url, label}` entries. `url` is an Article (its copy-link address, or `/search?view=…`) or, for a whole page, `/read/…`. `label` is "Paper, date: headline". |
| `image`, `image_alt` | together | Share image in `images/<file-name>/`. The site's social card is the default. |
| `updated` | no | On or after `date` |
| `tags` | no | Up to 12. Each links to the blog's posts with that tag (`/blog?tag=…`). Use words of letters, digits, hyphens, apostrophes, full stops or `&`, with single spaces, at most 40 characters ("St. John's", "Laxey & Lonan"). Case doesn't matter, so keep one spelling. The check refuses any other tag. |
| `author` | no | Default "Manx Papers" |
| `ai_assisted` | no | Default `true` |

Check locally with `node scripts/validate.mjs`. It needs Node 22 or later and no installs. Errors
fail the check; warnings are listed but don't. Run the
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
`vendor/web/` holds unchanged copies of the Web Worker's `blog.mjs`, `clipping.mjs`, `markdown.mjs`,
`proxy.mjs` and `security.mjs`, pinned by hash in `vendor/web/VENDOR.json`. When those change in
`Manx-Papers/web`:
1. copy all five again;
2. update the commit and hashes;
3. run the tests.

Web's `test/blog-vendor.test.mjs` pins the same hashes, so a web change to these files fails web CI
until this copy is updated. The current copy is from web `ac717e3`, the head of web#188 (archive
clippings, web#183); it becomes web `main` when that pull request merges.

## Publishing safeguards
- `main` is protected: changes arrive only by pull request with the owner's approval and a passing
  `content` check.
- Checking and publishing are separate jobs. Publishing runs in the `blog-publish` Environment,
  which only `main` can use, so no pull-request run can reach the content-store secrets.
- Every commit to `main` starts a run. A run publishes only if its commit is still the tip of
  `main`. Re-running an old run, or a run overtaken by a newer merge, publishes nothing and shows a
  warning (the newer commit's run publishes), so the store is never rolled back. If a warning says
  nothing published and no newer run did, run the workflow manually on `main`.

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
   - at least one claim must link to the archive (an Article, `/items/…`, or a page, `/read/…`);
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
- **Clippings from the archive.** Showing newspaper clippings is the main reason for the blog. Nothing
  is copied: the site draws each clipping from the page scan every time the post is read (web#183).
  - **Show what a paper said with a highlighted clipping, not a quote** (owner, 25 Nov): clip the
    section and highlight the key words (below). If the section was read too badly to highlight,
    still clip it, without a highlight, and give the corrected text in `::: text` (below). Quote the
    text only when no clipping can do it: the words run across several sections, the post already
    has 30 clippings, or it's a few words woven into a sentence. Quotes stay short and exact.
  - **A clipping is one section of a page** (a headline, a paragraph, a photograph), not a whole
    Article. Build the story from the sections you want: the headline, then a key paragraph, then
    the photo. Each shows exactly that section's outline, so nothing from the stories around it
    shows, and clicking it opens the whole Article on its own page, at that section.
  - Put each clipping on a line of its own: `![` + its headline in a few words + `](section:` + the
    section ID + `)`, with an optional caption of your own in quotes:

    ```markdown
    ![Clubman's T.T. rider weds](section:IMT/IMT-1954-04-24/0006/block/R00100-B000 "A T.T. rider marries.")
    ```

  - The section ID is the part of the section's copy-link address after `/sections/`, for example
    `IMT/IMT-1954-04-24/0006/block/R00100-B000`. Pasting the whole address after `section:` also
    works; the check stores it as the section ID.
  - Up to 30 clippings a post; not inside a `>` quote. Archive page images (`/media/…`) are refused:
    use a clipping.
  - **Highlighting words.** Add `?highlight=` and the words, joined by `+` as in a search address.
    Put a phrase in quote marks:

    ```markdown
    ![Clubman's T.T. rider weds](section:IMT/IMT-1954-04-24/0006/block/R00100-B000?highlight=rider+weds)
    ![The service](section:IMT/IMT-1954-04-24/0006/block/R00245-B000?highlight="Rev.+B.+Kelly")
    ```

    The words are marked on the clipping like a highlighter pen: a soft yellow band behind the print,
    one band for words that follow one another on the same printed line. In "Read the text" a phrase
    is marked as one, and the words are named in the clipping's alt text.
  - **Highlights match the text as the archive read it, not the true spelling.** The archive's text
    comes from automatic reading of the scan (OCR), so a word can be misread (for example "rn"
    read for "m"). A highlight only finds the words as they were read, and whole words
    only ("marry" does not find "married"). Open "Read the text" on the preview and copy the words
    from there. The check looks each clipping up in the archive and **warns** when a highlight
    finds nothing in that section, or when the section isn't in the archive. A warning doesn't stop
    the post, but nothing will be highlighted, so fix or remove the highlight. If the archive can't
    be reached, the check says so: check the clipping on the preview instead.
  - **Captions.** Under each clipping the site shows, in order: your caption, if you gave one; for
    a photograph, the newspaper's own printed caption, labelled "Printed caption:" (added
    automatically from the archive, nothing to do, and marked "(read by machine)"); then the
    paper, date and page. The caption has no links: the clipping itself opens the Article.
    - Your caption is your own note on why the clipping matters. Don't repeat the printed caption
      in it; the reader already sees that.
    - Don't also clip a photograph's caption section on its own: the photograph's clipping already
      shows that caption, so readers would see (and screen readers read) it twice.
  - **Every clipping must work without seeing it.** The alt text is `Clipping: "` + your headline
    + `"`, so give only the headline. Don't paste the article into it, and don't add the paper or
    date (the caption says those). Under the caption the site shows "Read the text", the section's
    text from the archive, for screen readers and anyone who finds old print hard to read.
    - Check that text on the preview. If the automatic reading has obvious mistakes, give a
      corrected version straight after the clipping line, between `::: text` and `:::`:

      ```markdown
      ![The wedding](section:IMT/IMT-1954-04-24/0006/block/R00100-B001)
      ::: text
      Clubman T.T. competitor Gwilym Owen (only son of Mr and Mrs R. Owen, of Brunswick Road) was
      married on Thursday last at Kirk Braddan…
      :::
      ```

    - Highlights still show on the clipping, but your corrected text has no marks.
    - A photograph or other picture has no text to read. Give a fuller description of what it shows
      instead, between `::: description` and `:::`; without one there is no "Read the text". Its
      printed caption is already shown, so don't copy it into the description.
    - If the archive can't be reached when the post is read, the site says the clipping can't be
      shown just now and keeps the caption, a View article link and any text you gave.
- **Other pictures** (modern photos, postcards and so on) go in `images/<file-name>/`:
  - `.jpg`, `.png` or `.webp`, up to 5 MB each;
  - every image needs alt text, and can have a caption.
- **Link to Articles, not pages.** Every factual claim links to the archive, and the link should be
  the **Article** it comes from. Press the Article's copy-link button (on its search result, in
  View Article or on the Article's page) and paste the address, for example
  `[the Examiner asked](https://beta.manxpapers.com/items/IME/IME-1946-07-05/0001/record/172)`.
  - The check accepts the address as pasted, from Beta or the live site, and stores it as the
    Article's page on the site, `/items/IME/IME-1946-07-05/0001/record/172` (web#189). Typing that
    path works too.
  - An older View Article address (`/search?view=…`) is stored as the Article's page as well. A
    section's address (`/sections/…`) stays a section page: the Article's page, opened at that
    section.
  - An Article link opens the story on its own page, even when it continues on another page of the
    paper.
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
| `sources` | yes | One or more `{url, label}` entries. `url` is an Article (its copy-link address, or `/items/…`) or, for a whole page, `/read/…`. `label` is "Paper, date: headline". |
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
until this copy is updated. The current copy is from web `main` at `6c77969` (the squash merge of
web#194: no Full page link in a clipping's caption, web#183). Web squash-merges, so record the commit on
web `main`, not a pull request's head.

## Publishing safeguards
- `main` is protected: changes arrive only by pull request with a passing `content` check, and the
  owner merges.
- Checking and publishing are separate jobs. Publishing runs in the `blog-publish` Environment,
  which only `main` can use, so no pull-request run can reach the content-store secrets.
- Every commit to `main` starts a run. A run publishes only if its commit is still the tip of
  `main`. Re-running an old run, or a run overtaken by a newer merge, publishes nothing and shows a
  warning (the newer commit's run publishes), so the store is never rolled back. If a warning says
  nothing published and no newer run did, run the workflow manually on `main`.

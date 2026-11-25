---
# Copy to posts/<file-name>.md. The file name is the address: posts/laxey-wheel.md → /blog/laxey-wheel
# (lower-case words joined by hyphens). Delete these comment lines if you like.
title: "The Laxey Wheel at 170"             # at most 120 characters
date: 2026-12-01                            # listed from 00:00 Isle of Man time on this date
summary: "One or two sentences for the blog index, search engines, link previews and RSS."  # at most 300
# image: laxey-wheel.jpg                    # optional share image, in images/<file-name>/
# image_alt: "What the image shows"         # required with image
# updated: 2026-12-03                       # optional, on or after date
# tags: [industry, Laxey]                   # optional
# author: "Manx Papers"                     # optional; this is the default
# ai_assisted: false                        # only when no AI was used; the default shows
#                                           # "Written with AI assistance."
# sources: the Articles the post relies on: paste each Article's copy-link address, with a label
# "Paper, date: headline". A /read/ page only when the point is the whole page.
sources:
  - url: https://beta.manxpapers.com/items/IME/IME-1946-07-05/0001/record/172
    label: "Isle of Man Examiner, 5 July 1946: Do We Still Offer a Magic Holiday Isle?"
  - url: /read/IME/IME-1946-07-05/1
    label: "Isle of Man Examiner, 5 July 1946: front page"
---
Open with the story. Link every factual claim to the Article it comes from, like
[the Examiner asked](/search?view=IME%2FIME-1946-07-05%2F0001%2Frecord%2F172). Link a whole page,
like [the front page](/read/IME/IME-1946-07-05/1), only when the point is the page itself.

## A heading (use ##, the title is the only top-level heading)

Plain Markdown: **bold**, *italic*, [links](/search?view=IME%2FIME-1946-07-05%2F0001%2Frecord%2F172), lists and quotes.

- A list item
- Another

> A short quotation from the paper.

A newspaper clipping is one section of a page: its headline in a few words, then `section:` and the
section ID (the part of the section's copy-link address after `/sections/`). Highlight words with
`?highlight=word+word`, spelt as in the archive's "Read the text". The site adds the paper and date,
and a "Read the text" section under it. Correct that text, if it needs it, in a `::: text` block
straight after the clipping (`::: description` for a picture); see the README.

![Clubman's T.T. rider weds](section:IMT/IMT-1954-04-24/0006/block/R00100-B000?highlight=rider+weds "Optional caption")
::: text
CLUBMAN'S T.T. RIDER WEDS
:::

A picture that isn't from the archive, such as a modern photo or a postcard, goes in `images/<file-name>/`
with alt text and an optional caption.

![Alt text describing the image](laxey-wheel.jpg "Optional caption")

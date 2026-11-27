// Control #244: a small, safe Markdown subset for blog posts. Raw HTML is never passed through:
// every character of source text is escaped, and only the tags below are generated. Links and
// images are limited to same-site paths (links may also be https:). The renderer reports what it
// dropped in `problems`, so the content repo's validator can refuse a post the site would alter.
//
// Blocks: ## to #### headings (a single # becomes ##: the page title is the only h1), paragraphs,
// - / * / 1. lists, > quotes, --- rules, and a figure for an image alone on its line:
// ![alt](src "optional caption"). Inline: `code`, [text](href), **strong**, *em* / _em_.
//
// web#183 (owner, 25 Nov): a newspaper clipping is one section of a page, named by its section ID,
// optionally with words or a "quoted phrase" to highlight, written as in a search address (+ for a
// space, %22 or " for a quote mark):
//   ![Clubman's T.T. rider weds](section:IMT/IMT-1954-04-24/0006/block/R00100-B000?highlight=rider+weds "Optional caption")
// The alt text is the clipping's headline in a few words; the site adds the paper and date. The line
// may be followed at once by a block that replaces the machine-read text in "Read the text":
//   ::: text            (the author's corrected text)       ::: description   (for a picture)
//   ...paragraphs...                                          ...paragraphs...
//   :::                                                       :::
// The renderer leaves a <!--clipping:N--> marker (source '<' is always escaped, so only this code
// makes one) and returns the clippings; blog.mjs fills them in from the archive (clipping.mjs).

export const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

const SITE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~/?=&%:+,;@]*(?:#[A-Za-z0-9_-]+)?$/;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9\-._~/?=&%:+,;@!*()]*)?(?:#[A-Za-z0-9_-]*)?$/;
export function safeHref(href) {
  return (SITE_PATH.test(href) || HTTPS.test(href) || /^#[A-Za-z0-9_-]+$/.test(href)) && !/[\\<>"'\s]/.test(href);
}
export const IMAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(?:jpg|jpeg|png|webp)$/;
// A bare file name is a post image (/blog/images/<slug>/<file>); otherwise an archive Media image.
export function imageSrc(src, slug) {
  if (IMAGE_FILE.test(src)) return '/blog/images/' + slug + '/' + src;
  const own = /^\/blog\/images\/([a-z0-9-]+)\/([^/]+)$/.exec(src);
  if (own && own[1] === slug && IMAGE_FILE.test(own[2])) return src;
  return null;
}

// TITLE/ISSUE/PAGE/block/BLOCK, the issue starting with its title, page 0001-9999; optional
// ?highlight=<words>, at most 120 characters once decoded: letters, digits, spaces, quote marks,
// apostrophes, full stops, commas, hyphens and &.
const REFERENCE = /^section:([A-Z][A-Z0-9]{1,11})\/([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*)\/(\d{4})\/block\/([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*)(?:\?highlight=([^?#&=\s]+))?$/;
const HIGHLIGHT = /^[\p{L}\p{N}\p{M} "'’.,&-]{1,120}$/u;
export const MAX_CLIPPINGS = 30;
export const MAX_ALT = 200;
export const isClippingSource = src => /^(?:section|article):/.test(src);
// {id, highlight} for a valid clipping reference, or null.
export function parseReference(src) {
  const m = REFERENCE.exec(src ?? '');
  if (!m) return null;
  const [, title, issue, page, block, raw] = m;
  if (issue.length > 64 || block.length > 64 || !(issue.startsWith(title + '-') || issue.startsWith(title + '_')) || page === '0000') return null;
  let highlight = null;
  if (raw !== undefined) {
    try { highlight = decodeURIComponent(raw.replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim(); } catch { return null; }
    if (!HIGHLIGHT.test(highlight) || !/[\p{L}\p{N}]/u.test(highlight)) return null;
  }
  return {id: title + '/' + issue + '/' + page + '/block/' + block, highlight};
}

// Emphasis on escaped text, so the only '<' present are tags made here. A span never contains its
// own marker or a stray '<', only text and complete tags from an earlier pass, so tags always nest
// properly. Each match stops at the next marker, which keeps unmatched markers linear.
const STAR = /(^|[^\w*])\*(?=[^\s*])((?:[^*<]|<strong>[^<]*<\/strong>)+?)(?<=\S)\*(?![\w*])/g;
const UNDER = /(^|[^\w])_(?=[^\s_])((?:[^_<]|<strong>[^<]*<\/strong>)+?)(?<=\S)_(?!\w)/g;
const STRONG = /\*\*(?=[^\s*])((?:[^*<]|<em>[^<]*<\/em>)+?)(?<=\S)\*\*/g;
function emphasis(escaped) {
  const em = text => text.replace(STAR, '$1<em>$2</em>').replace(UNDER, '$1<em>$2</em>');
  return em(em(escaped).replace(STRONG, '<strong>$1</strong>'));
}

export function inline(text, problems = []) {
  let out = '', last = 0;
  const token = /`([^`]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|!\[/g;
  for (const m of text.matchAll(token)) {
    out += emphasis(escapeHTML(text.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out += '<code>' + escapeHTML(m[1]) + '</code>';
    else if (m[2] !== undefined) {
      if (safeHref(m[3])) out += '<a href="' + escapeHTML(m[3]) + '">' + emphasis(escapeHTML(m[2])) + '</a>';
      else { problems.push('link not allowed: ' + m[3]); out += emphasis(escapeHTML(m[2])); }
    } else { problems.push('images must stand alone on their own line'); out += escapeHTML(m[0]); }
  }
  return out + emphasis(escapeHTML(text.slice(last)));
}

const FIGURE = /^!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"([^"\n]*)")?\)$/;
const BLOCK_OPEN = /^:::\s*(text|description)$/;
// `image` (Control #270, the draft preview) maps a post image's file name to the address it is shown
// from; without it, the post's own folder in the content store.
export function renderMarkdown(source, {slug = '', nested = false, image} = {}) {
  const problems = [], clippings = [];
  let block = null, lastClipping = null;
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let paragraph = [], list = null, quote = [];
  const flushParagraph = () => { if (paragraph.length) html.push('<p>' + inline(paragraph.join(' '), problems) + '</p>'); paragraph = []; };
  const flushList = () => { if (list) html.push('<' + list.tag + '>' + list.items.map(i => '<li>' + inline(i, problems) + '</li>').join('') + '</' + list.tag + '>'); list = null; };
  const flushQuote = () => {
    if (!quote.length) return;
    const inner = renderMarkdown(quote.join('\n'), {slug, nested: true, image});
    problems.push(...inner.problems);
    html.push('<blockquote>' + inner.html + '</blockquote>');
    quote = [];
  };
  const flush = () => { flushParagraph(); flushList(); flushQuote(); };
  const closeBlock = () => {
    const paragraphs = block.lines.join('\n').split(/\n\s*\n/).map(p => p.trim().replace(/\s*\n\s*/g, ' ')).filter(Boolean);
    if (!paragraphs.length) problems.push('the ::: ' + block.kind + ' block is empty');
    else block.clip.override = {kind: block.kind, html: paragraphs.map(p => '<p>' + inline(p, problems) + '</p>').join('')};
    block = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const following = lastClipping;
    lastClipping = null;
    if (block) { if (line.trim() === ':::') closeBlock(); else block.lines.push(line); continue; }
    if (/^:::/.test(line.trim())) {
      const open = BLOCK_OPEN.exec(line.trim());
      if (open && following && !following.override) { block = {kind: open[1], lines: [], clip: following}; continue; }
      flush();
      problems.push(open ? 'a ::: ' + open[1] + ' block must come straight after its section: clipping line' : 'unknown ::: block: ' + line.trim().slice(0, 40));
      continue;
    }
    if (/^\s*>/.test(line)) { flushParagraph(); flushList(); quote.push(line.replace(/^\s*>\s?/, '')); continue; }
    flushQuote();
    if (!line.trim()) { flush(); continue; }
    if (/^\s*<\/?[A-Za-z!]/.test(line)) problems.push('raw HTML is shown as text: ' + line.trim().slice(0, 40));
    let m;
    if ((m = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line))) {
      flush();
      if (m[1].length === 1) problems.push('use ## for headings: the post title is the only top-level heading');
      const level = Math.max(2, m[1].length);
      html.push('<h' + level + '>' + inline(m[2], problems) + '</h' + level + '>');
    } else if (/^(?:-{3,}|\*{3,})$/.test(line.trim())) { flush(); html.push('<hr>'); }
    else if ((m = FIGURE.exec(line.trim())) && isClippingSource(m[2])) {
      flush();
      const reference = parseReference(m[2]), alt = m[1].trim();
      if (!reference) problems.push('not an archive section reference: ' + m[2] + ' (use section:TITLE/ISSUE/PAGE/block/ID, as in a section\'s copy-link address, optionally ?highlight=word+word)');
      else if (nested) problems.push('clippings cannot go inside a quote: ' + m[2]);
      else if (!alt) problems.push('clipping needs alt text (its headline in a few words): ' + m[2]);
      else if (alt.length > MAX_ALT) problems.push('clipping alt text is longer than ' + MAX_ALT + ' characters: ' + m[2]);
      else if (clippings.length >= MAX_CLIPPINGS) problems.push('at most ' + MAX_CLIPPINGS + ' clippings in a post: ' + m[2]);
      else {
        lastClipping = {...reference, alt, caption: m[3] ? inline(m[3], problems) : ''};
        html.push('<!--clipping:' + clippings.length + '-->');
        clippings.push(lastClipping);
      }
    } else if ((m = FIGURE.exec(line.trim()))) {
      flush();
      const src = imageSrc(m[2], slug);
      if (!src) problems.push(m[2].startsWith('/media/')
        ? 'archive page images are not allowed in posts: show a section as a clipping with ![headline](section:<section ID>): ' + m[2]
        : 'image not allowed: ' + m[2]);
      else if (!m[1].trim()) problems.push('image needs alt text: ' + m[2]);
      else html.push('<figure><img src="' + escapeHTML(image ? image(src.slice(src.lastIndexOf('/') + 1)) : src) + '" alt="' + escapeHTML(m[1].trim()) + '" loading="lazy" decoding="async">'
        + (m[3] ? '<figcaption>' + inline(m[3], problems) + '</figcaption>' : '') + '</figure>');
    } else if ((m = /^\s*(?:([-*])|(\d{1,3})[.)])\s+(.*)$/.exec(line))) {
      flushParagraph();
      const tag = m[1] ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ??= {tag, items: []};
      list.items.push(m[3]);
    } else if (list && /^\s{2,}\S/.test(raw)) list.items[list.items.length - 1] += ' ' + line.trim();
    else { flushList(); paragraph.push(line.trim()); }
  }
  if (block) { problems.push('the ::: ' + block.kind + ' block has no closing :::'); closeBlock(); }
  flush();
  return {html: html.join('\n'), problems, clippings};
}

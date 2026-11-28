// web#183: newspaper clippings in blog posts, drawn from the archive at request time.
// Owner, 25 Nov: a clipping is ONE section (block) of the page, not a whole Article. The writer builds
// the story from the sections they want (the headline, a key paragraph, the photo), each on its own line:
//   ![Clubman's T.T. rider weds](section:IMT/IMT-1954-04-24/0006/block/R00100-B000?highlight=rider+weds "Caption")
// Nothing is copied into the blog store: the Worker reads the section through the API service binding
// (/api/sections/<id>, with ?q= for highlights) and the browser loads the page scan from the same-origin
// /media/ proxy. The scan is masked with an SVG clip path to the section's own outline (the API's
// polygon), so nothing from neighbouring items shows. The clipping is a link to the whole Article in
// View Article. Highlighted words are drawn over the scan from the API's per-word boxes and marked in
// "Read the text". Highlights match the recognised (OCR) text, not the true spelling; one that finds
// nothing is simply not drawn here (the content repo's check warns the writer before merge).
// If the section cannot be loaded, the figure says so and keeps the caption and the View Article link.
import {escapeHTML} from './markdown.mjs';
import {origins, isMediaPath} from './proxy.mjs';

// Long sections are cut here in "Read the text"; the rest is one click away in View Article.
export const MAX_TEXT = 20000;
// A photograph's printed caption is cut at a word after this many characters (review of web#190).
export const MAX_PRINTED = 400;
// Cut text to at most max characters plus "…": back to the last whole word, unless that would lose
// more than CUT_SLACK characters (a very long "word", such as a misread run), then at max itself.
// Never between the two halves of a surrogate pair (review of web#192).
const CUT_SLACK = 40;
export function cutText(text, max) {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max, head = text.slice(0, end);
  const word = /\s/.test(text[end]) ? head : head.replace(/\s+\S*$/, '');
  return ((word.trim() && word.length >= end - CUT_SLACK ? word : head).trimEnd()) + '…';
}
// Sections are read in parallel; a 503 (busy) answer is retried after a short wait. All of a post's
// clippings share one time budget; any not read by then show the placeholder.
const BUDGET_MS = 10000, TIMEOUT_MS = 6000, BUSY_WAITS_MS = [250, 500, 1000];
// At most this many section reads are in flight for one page view.
export const MAX_PARALLEL = 6;
// Section documents are kept in the Worker's own named cache (never served to any request) for a day,
// keyed by the API address with its highlight, so repeat views and many readers don't each read the
// API. Section text and outlines change only when the archive is reprocessed; a day is the longest a
// correction takes to show. A section the archive doesn't have is remembered for ten minutes, so a
// broken clipping doesn't read the API on every view. Errors are never kept.
export const CACHE_NAME = 'blog-clipping-sections', CACHE_SECONDS = 86400, MISSING_SECONDS = 600;
async function openCache() {
  try { return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME); } catch { return null; }
}
function limiter(limit) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit || !waiting.length) return;
    active++;
    const {task, resolve, reject} = waiting.shift();
    task().then(resolve, reject).finally(() => { active--; next(); });
  };
  return task => new Promise((resolve, reject) => { waiting.push({task, resolve, reject}); next(); });
}

const longDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date ?? '')
  ? new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'}).format(new Date(date + 'T00:00:00Z'))
  : '';
// web#189: a clipping opens its Article's own page, at the clipping's section (section IDs have a
// /block/ part). The one place the clipping link target is set.
export const viewURL = id => (/\/(?:block|section)\//.test(id) ? '/sections/' : '/items/') + id;

// Markers for highlighted spans while the text is tidied (private-use characters: never in OCR text).
const OPEN = '', CLOSE = '';
const tidy = text => text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)
  .map(p => p.replace(/(\p{Ll})-\n\s*(?=\p{Ll})/gu, '$1').replace(/\s+/g, ' ').trim());
// Recognised text as paragraphs: lines joined, words broken at line ends rejoined.
export const readableText = text => tidy(String(text ?? '').replace(/[]/g, '')).filter(Boolean);
// The same as escaped HTML, with the given [start, end) spans of the text marked.
export function markedParagraphs(text, spans) {
  let source = String(text ?? '').replace(/[]/g, '');
  for (const [start, end] of [...spans].sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + OPEN + source.slice(start, end) + CLOSE + source.slice(end);
  return tidy(source).filter(p => p.replace(/[]/g, ''))
    .map(p => escapeHTML(p).replaceAll(OPEN, '<mark>').replaceAll(CLOSE, '</mark>'));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// apiOrigin is the deployment's canonical API origin (origins(env).api, Control #240 D1).
// A highlight with quote marks is read as exact phrases (syntax=operators): every word of the phrase is
// marked, common words too, and nothing outside it. Without that the API takes the words one by one,
// leaves out common words (Control #211) and marks each word wherever it appears in the section.
// The query is rebuilt so the operator syntax can't refuse it or change its meaning (review of web#212):
// each quoted phrase as written, then the other words lower-cased (so OR/AND are words), without the
// punctuation, -, |, ( or ) around them. Unbalanced quotes, or no phrase with a letter or digit, keep the
// highlight as words, as before.
const WORDISH = /[\p{L}\p{N}]/u;
export function highlightQuery(highlight) {
  const parts = highlight.split('"');
  if (parts.length % 2 === 0) return {q: highlight};
  const phrases = parts.filter((_, i) => i % 2).map(p => p.trim().replace(/\s+/g, ' ')).filter(p => WORDISH.test(p));
  if (!phrases.length) return {q: highlight};
  const words = parts.filter((_, i) => i % 2 === 0).join(' ').split(/\s+/)
    .map(w => w.replace(/[()|]/g, '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase()).filter(w => WORDISH.test(w));
  return {q: [...phrases.map(p => '"' + p + '"'), ...words].join(' '), syntax: 'operators'};
}
export const sectionURL = (id, highlight, apiOrigin) => apiOrigin + '/api/sections/' + id + (highlight ? '?' + new URLSearchParams(highlightQuery(highlight)) : '');
async function loadSection(url, env, deadline) {
  const api = env?.API;
  if (!api || typeof api.fetch !== 'function') throw new Error('no API binding');
  for (let attempt = 0; ; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('out of time');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, left));
    // The read and its body both give up at the time limit, even if the binding ignores the signal.
    const timedOut = new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timed out')), {once: true}));
    timedOut.catch(() => {});
    try {
      const response = await Promise.race([timedOut,
        api.fetch(new Request(url, {headers: {accept: 'application/json'}, signal: controller.signal}))]);
      if (response.status === 503 && attempt < BUSY_WAITS_MS.length && Date.now() + BUSY_WAITS_MS[attempt] < deadline) {
        await response.body?.cancel();
        await sleep(BUSY_WAITS_MS[attempt]);
        continue;
      }
      if (response.status === 404) { await response.body?.cancel(); return {missing: true}; }
      if (!response.ok) throw new Error('API status ' + response.status);
      return await Promise.race([timedOut, response.json()]);
    } finally { clearTimeout(timer); }
  }
}

const whole = n => Number.isInteger(n) && n > 0;
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const xywh = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > 0 && b[3] > 0;

// What a clipping shows, from the API's section document, or throws when it can't be drawn.
// mediaOrigin is the deployment's canonical Media origin (origins(env).media).
export function clippingLayout(doc, clip, mediaOrigin) {
  if (doc?.missing) throw new Error('no such section');
  const section = doc?.section;
  if (!section || section.id !== clip.id) throw new Error('not the requested section');
  const image = doc.original_image ?? {};
  const W = image.width, H = image.height;
  const path = typeof image.url === 'string' && image.url.startsWith(mediaOrigin + '/page/') ? '/media' + image.url.slice(mediaOrigin.length) : '';
  if (!whole(W) || !whole(H) || !isMediaPath(path)) throw new Error('no page image');
  // Media's search-page preview of the same page (WebP, longest side 2200 px, same proportions).
  const preview = path.replace(/^\/media\/page\/(.+)\.(?:jpg|png)$/, '/media/search-page-preview/$1.webp');
  // The section's exact outline; a rectangle from crop_ltrb when the API gives no polygon.
  const own = outline(section.geometry, W, H);
  if (!own) throw new Error('no outline');
  const {polygon, bounds: [L, T, R, B]} = own;
  // Word boxes in this section only. Their offsets are in the Item's text; the section's span in it
  // places them in the section's own text, and a mark is kept only where the two texts agree.
  const hits = (Array.isArray(doc.hit_geometry) ? doc.hit_geometry : []).filter(h => h?.block_id === section.source_block_id && xywh(h.box))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const itemSections = Array.isArray(doc.item?.sections) ? doc.item.sections : [];
  const itemText = typeof doc.item?.text === 'string' ? doc.item.text : '';
  const span = itemSections.find(s => s?.id === section.id)?.span;
  const text = typeof section.text === 'string' ? section.text : '';
  const spans = joinSpans(text, Array.isArray(span) && Number.isInteger(span[0]) ? hits.map(h => [h.start - span[0], h.end - span[0], h.text])
    .filter(([s, e, word]) => Number.isInteger(s) && e > s && s >= 0 && e <= text.length && text.slice(s, e).toLowerCase() === String(word).toLowerCase()) : []);
  // A photograph's own printed caption: the Caption sections of its picture Item (owner, 25 Nov).
  const role = s => s?.role?.definition?.label;
  const printed = doc.content_type === 'picture' && role(section) !== 'Caption'
    ? readableText(itemSections.filter(s => s?.id !== section.id && role(s) === 'Caption' && validSpan(s.span, itemText))
      .map(s => itemText.slice(s.span[0], s.span[1])).join('\n\n')).join(' ') : '';
  const printedShort = cutText(printed, MAX_PRINTED);
  // Owner, 26 Nov: the printed caption itself, cut from the same page and shown under the photograph at
  // the same print scale, with its text under Read the text. Only Caption sections with an outline.
  const captionSections = doc.content_type === 'picture' && role(section) !== 'Caption'
    ? itemSections.filter(s => s?.id !== section.id && role(s) === 'Caption') : [];
  const captions = captionSections.map(s => outline(s.geometry, W, H, {strict: false})).filter(Boolean);
  const printedParagraphs = captions.length ? readableText(captionSections.filter(s => validSpan(s.span, itemText))
    .map(s => itemText.slice(s.span[0], s.span[1])).join('\n\n')) : [];
  const citation = doc.citation ?? {};
  const date = citation.publication_date, pageNumber = Number(citation.page_number ?? doc.page_number);
  return {
    W, H, path, preview: preview !== path && isMediaPath(preview) ? preview : '', polygon, bounds: [L, T, R, B], hits: hits.map(h => h.box),
    bands: bands(hits, itemText), printed: printedShort, captions, printedParagraphs,
    picture: doc.content_type === 'picture',
    paper: typeof citation.title === 'string' ? citation.title : '',
    date: longDate(date),
    pageNumber: whole(pageNumber) ? pageNumber : null,
    provider: provider(doc.source_provider),
    text, spans,
  };
}

// Control #276: who holds the original, from the section document's own source_provider (the same
// credit the Item shows in Search and View Article). Its name, and its address only when that is a
// plain https:// URL; null without a name, so the line is left out.
function provider(given) {
  const name = typeof given?.name === 'string' ? given.name.trim() : '';
  if (!name) return null;
  let url = '';
  try {
    const parsed = typeof given.url === 'string' ? new URL(given.url) : null;
    if (parsed && parsed.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed.href;
  } catch {}
  return {name, url};
}

// A section's outline on its page, clamped to the page, with its bounding box; null without one.
// strict: an outline with no area is an error (the clipping's own section); otherwise it is skipped
// (a printed caption), so a bad caption outline never stops the photograph showing.
function outline(geometry, W, H, {strict = true} = {}) {
  const ltrb = geometry?.crop_ltrb, given = geometry?.polygon;
  let polygon = Array.isArray(given) && given.length >= 3 && given.every(point) ? given
    : Array.isArray(ltrb) && ltrb.length === 4 && ltrb.every(Number.isFinite) ? [[ltrb[0], ltrb[1]], [ltrb[2], ltrb[1]], [ltrb[2], ltrb[3]], [ltrb[0], ltrb[3]]] : null;
  if (!polygon) return null;
  polygon = polygon.map(([x, y]) => [Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y))]);
  const L = Math.floor(Math.min(...polygon.map(p => p[0]))), T = Math.floor(Math.min(...polygon.map(p => p[1])));
  const R = Math.ceil(Math.max(...polygon.map(p => p[0]))), B = Math.ceil(Math.max(...polygon.map(p => p[1])));
  if (R - L < 1 || B - T < 1) {
    if (strict) throw new Error('empty outline');
    return null;
  }
  return {polygon, bounds: [L, T, R, B]};
}
const validSpan = (span, text) => Array.isArray(span) && Number.isInteger(span[0]) && Number.isInteger(span[1]) && span[0] >= 0 && span[1] > span[0] && span[1] <= text.length;
// Only spaces (and at most a line end) between two highlighted words: they are one phrase. Without
// the text, words one character apart are.
const between = (text, from, to) => Number.isInteger(from) && Number.isInteger(to) && to >= from
  && (text.length && to <= text.length ? /^[^\S\n]*\n?[^\S\n]*$/.test(text.slice(from, to)) : to - from <= 1);

// Highlighted words that follow one another in the text become one mark in "Read the text".
export function joinSpans(text, spans) {
  const joined = [];
  for (const [s, e, word] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = joined.at(-1);
    if (last && s >= last[1] && between(text, last[1], s)) { last[1] = e; last[2] = text.slice(last[0], e); }
    else if (!last || s >= last[1]) joined.push([s, e, word]);
  }
  return joined;
}

// Highlighter pen (owner, 25 Nov): highlighted words that follow one another in the text and sit on
// the same printed line become one band, padded a little so it covers the letters' full height.
export function bands(hits, itemText) {
  const lines = [];
  for (const hit of hits) {
    const [x, y, w, h] = hit.box, last = lines.at(-1);
    const sameLine = last && y < last.y + last.h && y + h > last.y && Math.min(y + h, last.y + last.h) - Math.max(y, last.y) >= 0.5 * Math.min(h, last.h);
    if (last && sameLine && x >= last.x && between(itemText, last.end, hit.start)) {
      const top = Math.min(last.y, y), bottom = Math.max(last.y + last.h, y + h);
      Object.assign(last, {w: Math.max(last.x + last.w, x + w) - last.x, y: top, h: bottom - top, end: hit.end});
    } else lines.push({x, y, w, h, end: hit.end});
  }
  return lines.map(({x, y, w, h}) => {
    const px = Math.round(h * 0.15), py = Math.round(h * 0.15);
    return [x - px, y - py, w + 2 * px, h + 2 * py];
  });
}

// Owner, 26 Nov: a clipping is shown at its page's print scale, as if the whole page were this many CSS
// pixels wide, so the type is about the same size in every clipping. A single newspaper column (about an
// eighth of the page) comes out about 300px wide and reads at about its printed size; anything wider than
// about 28% of the page (most headlines and multi-column items) fills the post's column as before.
export const PRINT_PAGE_WIDTH = 2300;
export const printWidth = (sectionWidth, pageWidth) => Math.max(1, Math.round(Math.min(sectionWidth, PRINT_PAGE_WIDTH * sectionWidth / pageWidth)));
const pct = n => Number(n.toFixed(4)) + '%';
const frac = n => Number(n.toFixed(6));

// Owner, 25 Nov: clippings show Media's search-page preview of the page, not the original scan. An
// original is about 5300 x 7200 px (38 megapixels, about 150 MB once decoded) and a post can show
// sections of several pages; the preview is at most 2200 px on its long side (about 1600 x 2200, 3.6
// megapixels, about 14 MB decoded), in the same proportions. Every clipping of a page uses the same
// preview address, so the browser fetches and decodes it once. The image is placed, sized and masked in
// fractions of the page, and the highlights are drawn in page pixels on their own SVG, so they fit the
// preview without rescaling.

// Every clipping of a page shares one image address. Only the first is lazy: a lazy <img> paints only
// once its own lazy-load trigger fires, even when the image is already in memory, and a later clipping
// of the same page was seen to stay blank for seconds after the others had drawn. The others load
// eagerly at low priority, so they draw as soon as the page's one download arrives.
// One cut-out of the page: a box the part's shape holds the whole page image, moved so the part shows;
// the clip path (in the image's own 0-1 units) hides everything outside its outline. Highlights are
// drawn in page pixels on an SVG laid over the box. width: the part's share of the clipping's width.
function partHTML(layout, {polygon, bounds: [L, T, R, B]}, id, alt, width, {lazy, bands = []}) {
  const {W, H} = layout, w = R - L, h = B - T;
  const points = polygon.map(([x, y]) => frac(x / W) + ',' + frac(y / H)).join(' ');
  const marks = bands.length ? '<svg class="blog-clipping-hits" viewBox="' + L + ' ' + T + ' ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
    + bands.map(([x, y, bw, bh]) => '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + bh + '" rx="' + Math.round(bh * 0.2) + '"/>').join('') + '</svg>' : '';
  return '<span class="blog-clipping-part" style="' + (width < 100 ? 'width:' + pct(width) + ';' : '') + 'aspect-ratio:' + w + '/' + h + '">'
    + '<svg class="blog-clipping-mask" width="0" height="0" aria-hidden="true" focusable="false"><clipPath id="' + id + '" clipPathUnits="objectBoundingBox"><polygon points="' + points + '"/></clipPath></svg>'
    + '<img src="' + escapeHTML(layout.preview || layout.path) + '" alt="' + escapeHTML(alt) + '" width="' + W + '" height="' + H + '"' + (lazy ? ' loading="lazy"' : ' fetchpriority="low"') + ' decoding="async"'
    + ' style="width:' + pct(100 * W / w) + ';height:' + pct(100 * H / h) + ';left:' + pct(-100 * L / w) + ';top:' + pct(-100 * T / h) + ';clip-path:url(#' + id + ')">'
    + marks + '</span>';
}

// The clipping, and under a photograph its printed caption, all at the page's print scale and in one
// link that opens the whole Article. The caption's cut-out has empty alt: its text is in Read the text.
// It is a second <img> of the same page, so it loads eagerly at low priority (see above).
const clippingParts = layout => [{polygon: layout.polygon, bounds: layout.bounds}, ...(layout.captions ?? [])];
const partWidths = layout => clippingParts(layout).map(({bounds: [L, , R]}) => printWidth(R - L, layout.W));
function scanHTML(clip, layout, alt, n, {lazy = true} = {}) {
  const parts = clippingParts(layout), widths = partWidths(layout), widest = Math.max(...widths);
  return '<a class="blog-clipping-scan" href="' + escapeHTML(viewURL(clip.id)) + '" style="max-width:' + widest + 'px">'
    + parts.map((part, i) => partHTML(layout, part, 'clipping-' + n + (i ? '-caption-' + i : ''), i ? '' : alt, 100 * widths[i] / widest,
      {lazy: lazy && !i, bands: i ? [] : layout.bands})).join('')
    + '<span class="sr-only"> (opens the whole article)</span></a>';
}

// name: the clipping's name for its links, made unique in the post (see renderClippings).
function textHTML(clip, layout, name = clip.alt) {
  if (clip.override) {
    const label = clip.override.kind === 'description' ? 'Description' : 'Read the text';
    const note = clip.override.kind === 'description' ? '' : '<p class="blog-clipping-note">Text checked by the author.</p>';
    return '<details class="blog-clipping-text"><summary>' + label + '</summary>' + clip.override.html + note + '</details>';
  }
  if (!layout) return '';
  // A photograph: the text of its printed caption, when the caption itself is shown under it.
  if (layout.picture) return layout.printedParagraphs?.length ? '<details class="blog-clipping-text"><summary>Read the text</summary>'
    + layout.printedParagraphs.map(p => '<p>' + escapeHTML(p) + '</p>').join('')
    + '<p class="blog-clipping-note">The printed caption, read from the scan by machine, so it may contain errors.</p></details>' : '';
  let used = 0, cut = false;
  const paragraphs = [];
  for (const p of markedParagraphs(layout.text, layout.spans)) {
    const length = p.replace(/<\/?mark>/g, '').length;
    if (used + length > MAX_TEXT) { cut = true; break; }
    paragraphs.push('<p>' + p + '</p>'); used += length;
  }
  if (!paragraphs.length) return '';
  return '<details class="blog-clipping-text"><summary>Read the text</summary>' + paragraphs.join('')
    + '<p class="blog-clipping-note">' + (cut ? 'The text continues in <a href="' + escapeHTML(viewURL(clip.id)) + '">View article<span class="sr-only">: ' + escapeHTML(name) + '</span></a>. ' : '')
    + 'Text read from the scan by machine, so it may contain errors.</p></details>';
}

// The caption comes straight after the clipping: the writer's caption, the paper's own printed
// caption (a photograph's), then where it was printed. The clipping itself links to the whole
// Article, so the caption has no links (owner, 25 Nov: no full-size scan or full-page link), except
// in the placeholder, which has no clipping and so links the Article here. The paper and date are
// said here only, not in the alt text. Its parts are separated by a space as well as by layout, so
// they read apart without the stylesheet (reader mode, copied text). The printed caption is
// machine-read text, and says so. Control #276: under the paper and date, on its own line, who holds
// the original ("Source: Manx National Heritage"), its name linked to the provider's site.
function captionHTML(clip, layout, name = clip.alt) {
  const source = layout
    ? [layout.paper ? '<cite>' + escapeHTML(layout.paper) + '</cite>' : '', escapeHTML(layout.date), layout.pageNumber ? 'page ' + layout.pageNumber : ''].filter(Boolean).join(', ')
    : '<a href="' + escapeHTML(viewURL(clip.id)) + '">View article<span class="sr-only">: ' + escapeHTML(name) + '</span></a>';
  return '<figcaption>' + [clip.caption ? '<span class="blog-clipping-caption">' + clip.caption + '</span>' : '',
    layout?.printed && !layout.captions?.length ? '<span class="blog-clipping-printed"><span class="blog-clipping-label">Printed caption:</span> ' + escapeHTML(layout.printed)
      + ' <span class="blog-clipping-machine">(read by machine)</span></span>' : '',
    source ? '<span class="blog-clipping-source">' + source + '</span>' : '',
    layout?.provider ? '<span class="blog-clipping-provider">Source: ' + (layout.provider.url
      ? '<a href="' + escapeHTML(layout.provider.url) + '">' + escapeHTML(layout.provider.name) + '</a>'
      : escapeHTML(layout.provider.name)) + '</span>' : ''].filter(Boolean).join(' ') + '</figcaption>';
}

// A clipping is its figure (the clipping and its caption), then "Read the text". A figcaption must be
// the figure's first or last child, so the text follows the figure inside the clipping's wrapper.
export function clippingHTML(clip, layout, n, options) {
  const name = options?.name ?? clip.alt;
  if (!layout) {
    return '<div class="blog-clipping blog-clipping-unavailable"><figure>'
      + '<p class="blog-clipping-missing">This clipping can’t be shown just now: “' + escapeHTML(clip.alt) + '”.</p>'
      + captionHTML(clip, null, name) + '</figure>' + textHTML(clip, null, name) + '</div>';
  }
  // Clippings sharing a headline are numbered in their image link's name too (review of web#192).
  const number = name !== clip.alt && name.startsWith(clip.alt) ? name.slice(clip.alt.length) : '';
  const alt = 'Clipping: "' + clip.alt + '"' + number + (layout.hits.length ? ', highlighting “' + clip.highlight.replace(/"/g, '') + '”' : '');
  // Owner, 26 Nov: the clipping, its caption and Read the text are one column the clipping's print
  // width (at least 18rem, see site/style.css), centred in the post.
  return '<div class="blog-clipping" style="--clipping-width:' + Math.max(...partWidths(layout)) + 'px"><figure>' + scanHTML(clip, layout, alt, n, options) + captionHTML(clip, layout, name) + '</figure>' + textHTML(clip, layout, name) + '</div>';
}

// Replaces the renderer's <!--clipping:N--> markers. Never throws: a clipping that can't be drawn
// becomes the placeholder, and the rest of the post still renders.
// read: false (a HEAD request) leaves the clippings out without reading anything.
export async function renderClippings(html, clippings, env, {budget = BUDGET_MS, read = true, cache} = {}) {
  if (!clippings?.length) return html;
  if (!read) return html.replace(/<!--clipping:\d+-->/g, '');
  const upstream = origins(env);
  const deadline = Date.now() + budget, documents = new Map(), queue = limiter(MAX_PARALLEL);
  if (cache === undefined) cache = await openCache();
  const readSection = async (clip, key) => {
    try {
      const kept = await cache?.match(key);
      if (kept) return await kept.json();
    } catch (error) { console.error('clipping cache: ' + (error?.message ?? error)); }
    const doc = await queue(() => loadSection(key, env, deadline));
    if (cache && (doc?.missing === true || doc?.section?.id === clip.id)) {
      try {
        await cache.put(key, new Response(JSON.stringify(doc), {headers: {'Content-Type': 'application/json',
          'Cache-Control': 'max-age=' + (doc.missing ? MISSING_SECONDS : CACHE_SECONDS)}}));
      } catch (error) { console.error('clipping cache: ' + (error?.message ?? error)); }
    }
    return doc;
  };
  const layouts = await Promise.all(clippings.map(async clip => {
    // One read per section and highlight, however often the post shows it.
    const key = sectionURL(clip.id, clip.highlight, upstream.api);
    if (!documents.has(key)) documents.set(key, readSection(clip, key));
    try {
      const layout = clippingLayout(await documents.get(key), clip, upstream.media);
      if (clip.highlight && !layout.hits.length) console.error('clipping ' + clip.id + ': highlight "' + clip.highlight + '" matches nothing in the recognised text');
      return layout;
    } catch (error) {
      console.error('clipping ' + clip.id + ': ' + (error?.message ?? error));
      return null;
    }
  }));
  const pages = new Set(), alts = new Map(), seen = new Map();
  for (const clip of clippings) alts.set(clip.alt, (alts.get(clip.alt) ?? 0) + 1);
  const figures = clippings.map((clip, i) => {
    const layout = layouts[i], src = layout && (layout.preview || layout.path);
    const lazy = !pages.has(src);
    if (src) pages.add(src);
    // Clippings sharing a headline get their links told apart: Clipping: "Rider weds" (2), and
    // the View article links of a long text or a placeholder.
    seen.set(clip.alt, (seen.get(clip.alt) ?? 0) + 1);
    const name = alts.get(clip.alt) > 1 ? clip.alt + ' (' + seen.get(clip.alt) + ')' : clip.alt;
    return clippingHTML(clip, layout, i + 1, {lazy, name});
  });
  return html.replace(/<!--clipping:(\d+)-->/g, (_, i) => figures[Number(i)] ?? '');
}

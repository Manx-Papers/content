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
import {API_ORIGIN, MEDIA_ORIGIN, isMediaPath} from './proxy.mjs';

// Long sections are cut here in "Read the text"; the rest is one click away in View Article.
export const MAX_TEXT = 20000;
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
export const viewURL = id => '/search?view=' + encodeURIComponent(id);

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
export const sectionURL = (id, highlight) => API_ORIGIN + '/api/sections/' + id + (highlight ? '?' + new URLSearchParams({q: highlight}) : '');
async function loadSection(clip, env, deadline) {
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
        api.fetch(new Request(sectionURL(clip.id, clip.highlight), {headers: {accept: 'application/json'}, signal: controller.signal}))]);
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
export function clippingLayout(doc, clip) {
  if (doc?.missing) throw new Error('no such section');
  const section = doc?.section;
  if (!section || section.id !== clip.id) throw new Error('not the requested section');
  const image = doc.original_image ?? {};
  const W = image.width, H = image.height;
  const path = typeof image.url === 'string' && image.url.startsWith(MEDIA_ORIGIN + '/page/') ? '/media' + image.url.slice(MEDIA_ORIGIN.length) : '';
  if (!whole(W) || !whole(H) || !isMediaPath(path)) throw new Error('no page image');
  // Media's search-page preview of the same page (WebP, longest side 2200 px, same proportions).
  const preview = path.replace(/^\/media\/page\/(.+)\.(?:jpg|png)$/, '/media/search-page-preview/$1.webp');
  // The section's exact outline; a rectangle from crop_ltrb when the API gives no polygon.
  const ltrb = section.geometry?.crop_ltrb, given = section.geometry?.polygon;
  let polygon = Array.isArray(given) && given.length >= 3 && given.every(point) ? given
    : Array.isArray(ltrb) && ltrb.length === 4 && ltrb.every(Number.isFinite) ? [[ltrb[0], ltrb[1]], [ltrb[2], ltrb[1]], [ltrb[2], ltrb[3]], [ltrb[0], ltrb[3]]] : null;
  if (!polygon) throw new Error('no outline');
  polygon = polygon.map(([x, y]) => [Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y))]);
  const L = Math.floor(Math.min(...polygon.map(p => p[0]))), T = Math.floor(Math.min(...polygon.map(p => p[1])));
  const R = Math.ceil(Math.max(...polygon.map(p => p[0]))), B = Math.ceil(Math.max(...polygon.map(p => p[1])));
  if (R - L < 1 || B - T < 1) throw new Error('empty outline');
  // Word boxes in this section only. Their offsets are in the Item's text; the section's span in it
  // places them in the section's own text, and a mark is kept only where the two texts agree.
  const hits = (Array.isArray(doc.hit_geometry) ? doc.hit_geometry : []).filter(h => h?.block_id === section.source_block_id && xywh(h.box));
  const span = (doc.item?.sections ?? []).find(s => s?.id === section.id)?.span;
  const text = typeof section.text === 'string' ? section.text : '';
  const spans = Array.isArray(span) && Number.isInteger(span[0]) ? hits.map(h => [h.start - span[0], h.end - span[0], h.text])
    .filter(([s, e, word]) => Number.isInteger(s) && e > s && s >= 0 && e <= text.length && text.slice(s, e).toLowerCase() === String(word).toLowerCase()) : [];
  const citation = doc.citation ?? {};
  const record = typeof section.item?.id === 'string' ? section.item.id : '';
  const [title, issue] = clip.id.split('/');
  const date = citation.publication_date, pageNumber = Number(citation.page_number ?? doc.page_number);
  const readIssue = date && issue === title + '-' + date ? date : issue;
  return {
    W, H, path, preview: preview !== path && isMediaPath(preview) ? preview : '', polygon, bounds: [L, T, R, B], hits: hits.map(h => h.box),
    picture: doc.content_type === 'picture',
    paper: typeof citation.title === 'string' ? citation.title : '',
    date: longDate(date),
    pageNumber: whole(pageNumber) ? pageNumber : null,
    fullPage: whole(pageNumber) ? '/read/' + title + '/' + readIssue + '/' + pageNumber + (record ? '?unit=' + encodeURIComponent(record) : '') : '',
    text, spans,
  };
}

const pct = n => Number(n.toFixed(4)) + '%';
const frac = n => Number(n.toFixed(6));

// Owner, 25 Nov: clippings show Media's search-page preview of the page, not the original scan. An
// original is about 5300 x 7200 px (38 megapixels, about 150 MB once decoded) and a post can show
// sections of several pages; the preview is at most 2200 px on its long side (about 1600 x 2200, 3.6
// megapixels, about 14 MB decoded), in the same proportions. Every clipping of a page uses the same
// preview address, so the browser fetches and decodes it once. The caption links the original for full
// resolution. The image is placed and masked in fractions of the page, and the highlights are drawn in
// page pixels on their own SVG, so they fit the preview without rescaling.

function scanHTML(clip, layout, alt, n) {
  const {W, H, polygon, bounds: [L, T, R, B], hits} = layout, w = R - L, h = B - T, id = 'clipping-' + n;
  // A box the section's shape holds the whole page image, moved so the section shows; the clip path
  // (in the image's own 0-1 units) hides everything outside the section's outline. Highlights are
  // drawn in page pixels on an SVG laid over the box. The whole clipping opens the Article.
  const points = polygon.map(([x, y]) => frac(x / W) + ',' + frac(y / H)).join(' ');
  const marks = hits.length ? '<svg class="blog-clipping-hits" viewBox="' + L + ' ' + T + ' ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
    + hits.map(([x, y, bw, bh]) => '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + bh + '"/>').join('') + '</svg>' : '';
  return '<a class="blog-clipping-scan" href="' + escapeHTML(viewURL(clip.id)) + '" style="max-width:' + w + 'px">'
    + '<span class="blog-clipping-part" style="aspect-ratio:' + w + '/' + h + '">'
    + '<svg class="blog-clipping-mask" width="0" height="0" aria-hidden="true" focusable="false"><clipPath id="' + id + '" clipPathUnits="objectBoundingBox"><polygon points="' + points + '"/></clipPath></svg>'
    + '<img src="' + escapeHTML(layout.preview || layout.path) + '" alt="' + escapeHTML(alt) + '" width="' + W + '" height="' + H + '" loading="lazy" decoding="async"'
    + ' style="width:' + pct(100 * W / w) + ';left:' + pct(-100 * L / w) + ';top:' + pct(-100 * T / h) + ';clip-path:url(#' + id + ')">'
    + marks + '</span><span class="sr-only"> (opens the whole article)</span></a>';
}

function textHTML(clip, layout) {
  if (clip.override) {
    const label = clip.override.kind === 'description' ? 'Description' : 'Read the text';
    const note = clip.override.kind === 'description' ? '' : '<p class="blog-clipping-note">Text checked by the author.</p>';
    return '<details class="blog-clipping-text"><summary>' + label + '</summary>' + clip.override.html + note + '</details>';
  }
  if (!layout || layout.picture) return '';
  let used = 0, cut = false;
  const paragraphs = [];
  for (const p of markedParagraphs(layout.text, layout.spans)) {
    const length = p.replace(/<\/?mark>/g, '').length;
    if (used + length > MAX_TEXT) { cut = true; break; }
    paragraphs.push('<p>' + p + '</p>'); used += length;
  }
  if (!paragraphs.length) return '';
  return '<details class="blog-clipping-text"><summary>Read the text</summary>' + paragraphs.join('')
    + '<p class="blog-clipping-note">' + (cut ? 'The text continues in <a href="' + escapeHTML(viewURL(clip.id)) + '">View article</a>. ' : '')
    + 'Text read from the scan by machine, so it may contain errors.</p></details>';
}

function captionHTML(clip, layout) {
  const where = layout ? [layout.paper ? '<cite>' + escapeHTML(layout.paper) + '</cite>' : '', escapeHTML(layout.date), layout.pageNumber ? 'page ' + layout.pageNumber : ''].filter(Boolean).join(', ') : '';
  const links = '<a href="' + escapeHTML(viewURL(clip.id)) + '">View article</a>'
    + (layout?.fullPage ? ' · <a href="' + escapeHTML(layout.fullPage) + '">Full page</a>' : '')
    + (layout?.preview ? ' · <a href="' + escapeHTML(layout.path) + '">Full-size scan</a>' : '');
  return '<figcaption>' + (clip.caption ? '<span class="blog-clipping-caption">' + clip.caption + '</span> ' : '')
    + '<span class="blog-clipping-source">' + (where ? where + ' · ' : '') + links + '</span></figcaption>';
}

export function clippingHTML(clip, layout, n) {
  if (!layout) {
    return '<figure class="blog-clipping blog-clipping-unavailable">'
      + '<p class="blog-clipping-missing">This clipping can’t be shown just now: “' + escapeHTML(clip.alt) + '”.</p>'
      + textHTML(clip, null) + captionHTML(clip, null) + '</figure>';
  }
  const alt = 'Clipping: "' + clip.alt + '"' + (layout.paper ? ', ' + layout.paper : '') + (layout.date ? ', ' + layout.date : '')
    + (layout.hits.length ? ', highlighting “' + clip.highlight.replace(/"/g, '') + '”' : '');
  return '<figure class="blog-clipping">' + scanHTML(clip, layout, alt, n) + textHTML(clip, layout) + captionHTML(clip, layout) + '</figure>';
}

// Replaces the renderer's <!--clipping:N--> markers. Never throws: a clipping that can't be drawn
// becomes the placeholder, and the rest of the post still renders.
// read: false (a HEAD request) leaves the clippings out without reading anything.
export async function renderClippings(html, clippings, env, {budget = BUDGET_MS, read = true, cache} = {}) {
  if (!clippings?.length) return html;
  if (!read) return html.replace(/<!--clipping:\d+-->/g, '');
  const deadline = Date.now() + budget, documents = new Map(), queue = limiter(MAX_PARALLEL);
  if (cache === undefined) cache = await openCache();
  const readSection = async (clip, key) => {
    try {
      const kept = await cache?.match(key);
      if (kept) return await kept.json();
    } catch (error) { console.error('clipping cache: ' + (error?.message ?? error)); }
    const doc = await queue(() => loadSection(clip, env, deadline));
    if (cache && (doc?.missing === true || doc?.section?.id === clip.id)) {
      try {
        await cache.put(key, new Response(JSON.stringify(doc), {headers: {'Content-Type': 'application/json',
          'Cache-Control': 'max-age=' + (doc.missing ? MISSING_SECONDS : CACHE_SECONDS)}}));
      } catch (error) { console.error('clipping cache: ' + (error?.message ?? error)); }
    }
    return doc;
  };
  const figures = await Promise.all(clippings.map(async (clip, i) => {
    // One read per section and highlight, however often the post shows it.
    const key = sectionURL(clip.id, clip.highlight);
    if (!documents.has(key)) documents.set(key, readSection(clip, key));
    try {
      const layout = clippingLayout(await documents.get(key), clip);
      if (clip.highlight && !layout.hits.length) console.error('clipping ' + clip.id + ': highlight "' + clip.highlight + '" matches nothing in the recognised text');
      return clippingHTML(clip, layout, i + 1);
    } catch (error) {
      console.error('clipping ' + clip.id + ': ' + (error?.message ?? error));
      return clippingHTML(clip, null, i + 1);
    }
  }));
  return html.replace(/<!--clipping:(\d+)-->/g, (_, i) => figures[Number(i)] ?? '');
}

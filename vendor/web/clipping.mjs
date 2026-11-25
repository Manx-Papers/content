// web#183: newspaper clippings in blog posts, drawn from the archive at request time.
// A post line ![Short headline](article:<Item ID> "optional caption") becomes a <figure> showing the
// Article cropped from the original page scan. Nothing is copied into the blog store: the Worker reads
// the Article through the API service binding (the same document the site's View Article uses) and the
// browser loads the page image from the same-origin /media/ proxy.
//
// Owner, 24 Nov: articles are often not rectangular (L-shapes, column wraps), so a clipping is never
// one box round the Article. It is drawn from the Article's own block regions on one page, and an SVG
// clip path masks the scan to exactly those blocks, so nothing from neighbouring items shows.
// Blocks are taken in reading order and gathered into runs: a block that starts just below the run
// before it, overlapping it across the page, joins that run and keeps its place in it, so a headline
// over a narrower column, or an L-shape, looks as it does on the page. A block that jumps back up the
// page (the story continues at the top of the next column) or far down it starts a new run. Runs are
// stacked one under another in reading order, at one common scale, so a story that wraps across
// columns reads down the blog column instead of becoming a wide box of mostly empty page.
//
// Which page: an Article on several pages shows its first part, or the page chosen with ?page=N
// (article:IMT/IMT-1938-10-08/0004/record/231?page=4). A Picture shows only its own regions.
// If the Article cannot be loaded, the figure says so and keeps the caption and the View Article link.
import {escapeHTML} from './markdown.mjs';
import {API_ORIGIN, MEDIA_ORIGIN, isMediaPath} from './proxy.mjs';

// Long Articles are cut here in "Read the text"; the rest is one click away in View Article.
export const MAX_TEXT = 20000;
// Text shorter than this (a stray caption line) is not worth a "Read the text".
const MIN_TEXT = 40;
// The API builds one Article document at a time and answers 503 ("reader busy") to a second request
// made meanwhile, so clippings are read one after another, retrying a busy answer after a short wait.
// All of a post's clippings share one time budget; any not read by then show the placeholder.
const BUDGET_MS = 10000, TIMEOUT_MS = 6000, BUSY_WAITS_MS = [250, 500, 1000];
// Extra source pixels round each block, so the mask never shaves the edge of a letter.
const MARGIN = 6;
// A block joins the run above it when it starts within this many source pixels of the run's foot
// (above it, for overlapping padded blocks, or below it, for the space between paragraphs).
const OVERLAP = 40, GAP = 150;

// Blocks ([l, t, r, b], in reading order) gathered into runs of blocks that follow on down the page.
export function blockRuns(blocks) {
  const runs = [];
  for (const block of blocks) {
    const run = runs.at(-1), [L, T, R, B] = run?.bounds ?? [];
    if (run && block[0] < R && block[2] > L && block[1] >= B - OVERLAP && block[1] <= B + GAP) {
      run.blocks.push(block);
      run.bounds = [Math.min(L, block[0]), T, Math.max(R, block[2]), Math.max(B, block[3])];
    } else runs.push({blocks: [block], bounds: [...block]});
  }
  return runs;
}

const longDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date ?? '')
  ? new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'}).format(new Date(date + 'T00:00:00Z'))
  : '';
export const viewURL = id => '/search?view=' + encodeURIComponent(id);

// Recognised text as paragraphs: lines joined, words broken at line ends rejoined.
export function readableText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)
    .map(p => p.replace(/(\p{Ll})-\n\s*(?=\p{Ll})/gu, '$1').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function loadArticle(id, env, deadline) {
  const api = env?.API;
  if (!api || typeof api.fetch !== 'function') throw new Error('no API binding');
  for (let attempt = 0; ; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('out of time');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, left));
    try {
      const response = await api.fetch(new Request(API_ORIGIN + '/api/items/' + id + '?view=article',
        {headers: {accept: 'application/json'}, signal: controller.signal}));
      if (response.status === 503 && attempt < BUSY_WAITS_MS.length && Date.now() + BUSY_WAITS_MS[attempt] < deadline) {
        await response.body?.cancel();
        await sleep(BUSY_WAITS_MS[attempt]);
        continue;
      }
      if (!response.ok) throw new Error('API status ' + response.status);
      return await response.json();
    } finally { clearTimeout(timer); }
  }
}

const whole = n => Number.isInteger(n) && n > 0;
const box = ltrb => Array.isArray(ltrb) && ltrb.length === 4 && ltrb.every(Number.isFinite) && ltrb[2] > ltrb[0] && ltrb[3] > ltrb[1];

// The page, blocks and text a clipping shows, or throws when the document can't be drawn.
export function clippingLayout(view, reference) {
  const pictures = new Set((view?.picture_associations ?? []).map(p => p?.item_id).filter(Boolean));
  const picture = pictures.has(reference.id);
  const components = (view?.components ?? []).filter(c => picture ? c?.item?.id === reference.id : !pictures.has(c?.item?.id));
  const shown = new Set(components.map(c => c.item.id));
  const pages = (view?.pages ?? []).map(page => ({...page, regions: (page.regions ?? []).filter(r => shown.has(r?.item?.id) && box(r?.geometry?.crop_ltrb))}))
    .filter(page => page.regions.length);
  if (!pages.length) throw new Error('no regions');
  const page = (reference.page && pages.find(p => p.page_number === reference.page)) || pages[0];
  if (reference.page && page.page_number !== reference.page) console.error('clipping ' + reference.id + ': no part on page ' + reference.page);
  const image = page.original_image ?? {};
  const W = image.width, H = image.height;
  const path = typeof image.url === 'string' && image.url.startsWith(MEDIA_ORIGIN + '/page/') ? '/media' + image.url.slice(MEDIA_ORIGIN.length) : '';
  if (!whole(W) || !whole(H) || !isMediaPath(path)) throw new Error('no page image');
  // Reading order is the Article's display order; regions it does not list keep their page order after.
  const order = new Map((view?.display_order ?? []).map((entry, i) => [entry?.section_id, i]));
  const rank = region => order.get(region.section_id) ?? order.size;
  const blocks = page.regions.map((region, i) => ({region, i})).sort((a, b) => rank(a.region) - rank(b.region) || a.i - b.i).map(({region}) => {
    const [l, t, r, b] = region.geometry.crop_ltrb;
    return [Math.max(0, l - MARGIN), Math.max(0, t - MARGIN), Math.min(W, r + MARGIN), Math.min(H, b + MARGIN)];
  }).filter(box);
  if (!blocks.length) throw new Error('regions outside the page');
  const runs = blockRuns(blocks);
  const citation = components.find(c => c.citation?.page_id === page.page_id)?.citation ?? components[0]?.citation ?? {};
  const first = page.regions[0].item.id;
  const issue = /^[A-Z][A-Z0-9]{1,11}\/([^/]+)\/\d{4}$/.exec(page.page_id ?? '')?.[1] ?? '';
  const title = first.split('/')[0];
  const date = citation.publication_date;
  const readIssue = date && issue === title + '-' + date ? date : issue;
  return {
    picture, path, W, H, runs,
    paper: typeof citation.title === 'string' ? citation.title : '',
    date: longDate(date),
    pageNumber: page.page_number,
    pageNumbers: pages.map(p => p.page_number),
    fullPage: '/read/' + title + '/' + readIssue + '/' + Number(page.page_number) + '?unit=' + encodeURIComponent(first),
    text: picture ? [] : readableText(components.map(c => c.text ?? '').join('\n\n')),
  };
}

const pct = n => Number(n.toFixed(4)) + '%';
const frac = n => Number(n.toFixed(6));

function scanHTML(layout, alt, n) {
  const {W, H, runs} = layout, widest = Math.max(...runs.map(({bounds: [L, , R]}) => R - L));
  // Each run is a box the run's shape, as wide as the run is relative to the widest one (one scale for
  // all), never wider than the scan's own pixels. The whole page image sits in it, moved so the run
  // shows, and the clip path (in the image's own 0-1 units) hides everything but the run's blocks.
  // The browser fetches the page image once however many runs show it. The first image carries the
  // clipping's alt text; the others are the same clipping and are silent.
  const parts = runs.map(({blocks, bounds: [L, T, R, B]}, k) => {
    const w = R - L, h = B - T, id = 'clipping-' + n + '-' + (k + 1);
    const rects = blocks.map(([l, t, r, b]) => '<rect x="' + frac(l / W) + '" y="' + frac(t / H) + '" width="' + frac((r - l) / W) + '" height="' + frac((b - t) / H) + '"/>').join('');
    return '<div class="blog-clipping-part" style="width:' + pct(100 * w / widest) + ';aspect-ratio:' + w + '/' + h + '">'
      + '<svg class="blog-clipping-mask" width="0" height="0" aria-hidden="true" focusable="false"><clipPath id="' + id + '" clipPathUnits="objectBoundingBox">' + rects + '</clipPath></svg>'
      + '<img src="' + escapeHTML(layout.path) + '" alt="' + (k ? '' : escapeHTML(alt)) + '" width="' + W + '" height="' + H + '" loading="lazy" decoding="async"'
      + ' style="width:' + pct(100 * W / w) + ';left:' + pct(-100 * L / w) + ';top:' + pct(-100 * T / h) + ';clip-path:url(#' + id + ')">'
      + '</div>';
  });
  return '<div class="blog-clipping-scan" style="max-width:' + widest + 'px">' + parts.join('') + '</div>';
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
  for (const p of layout.text) {
    if (used + p.length > MAX_TEXT) { cut = true; break; }
    paragraphs.push('<p>' + escapeHTML(p) + '</p>'); used += p.length;
  }
  if (used < MIN_TEXT) return '';
  return '<details class="blog-clipping-text"><summary>Read the text</summary>' + paragraphs.join('')
    + '<p class="blog-clipping-note">' + (cut ? 'The text continues in <a href="' + escapeHTML(viewURL(clip.id)) + '">View article</a>. ' : '')
    + 'Text read from the scan by machine, so it may contain errors.</p></details>';
}

function captionHTML(clip, layout) {
  const pages = layout?.pageNumbers ?? [];
  const others = pages.filter(p => p !== layout?.pageNumber);
  const where = layout ? [layout.paper ? '<cite>' + escapeHTML(layout.paper) + '</cite>' : '', escapeHTML(layout.date), 'page ' + layout.pageNumber].filter(Boolean).join(', ')
    + (others.length ? ' (the article is on pages ' + pages.join(' and ').replace(/ and (?=.* and )/g, ', ') + ')' : '') : '';
  const links = '<a href="' + escapeHTML(viewURL(clip.id)) + '">View article</a>'
    + (layout ? ' · <a href="' + escapeHTML(layout.fullPage) + '">Full page</a>' : '');
  return '<figcaption>' + (clip.caption ? '<span class="blog-clipping-caption">' + clip.caption + '</span> ' : '')
    + '<span class="blog-clipping-source">' + (where ? where + ' · ' : '') + links + '</span></figcaption>';
}

export function clippingHTML(clip, layout, n) {
  if (!layout) {
    return '<figure class="blog-clipping blog-clipping-unavailable">'
      + '<p class="blog-clipping-missing">This clipping can’t be shown just now: “' + escapeHTML(clip.alt) + '”.</p>'
      + textHTML(clip, null) + captionHTML(clip, null) + '</figure>';
  }
  const alt = 'Clipping: "' + clip.alt + '"' + (layout.paper ? ', ' + layout.paper : '') + (layout.date ? ', ' + layout.date : '');
  return '<figure class="blog-clipping">' + scanHTML(layout, alt, n) + textHTML(clip, layout) + captionHTML(clip, layout) + '</figure>';
}

// Replaces the renderer's <!--clipping:N--> markers. Never throws: a clipping that can't be drawn
// becomes the placeholder, and the rest of the post still renders.
export async function renderClippings(html, clippings, env, {budget = BUDGET_MS} = {}) {
  if (!clippings?.length) return html;
  // One read per Article, however often the post clips it; a failed read is not retried for the
  // Article's later clippings.
  const deadline = Date.now() + budget, documents = new Map(), figures = [];
  for (const [i, clip] of clippings.entries()) {
    try {
      if (!documents.has(clip.id)) documents.set(clip.id, loadArticle(clip.id, env, deadline).catch(error => error));
      const view = await documents.get(clip.id);
      if (view instanceof Error) throw view;
      figures.push(clippingHTML(clip, clippingLayout(view, clip), i + 1));
    } catch (error) {
      console.error('clipping ' + clip.id + ': ' + (error?.message ?? error));
      figures.push(clippingHTML(clip, null, i + 1));
    }
  }
  return html.replace(/<!--clipping:(\d+)-->/g, (_, i) => figures[Number(i)] ?? '');
}

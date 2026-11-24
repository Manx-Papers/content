// Control #244: the blog, served from the content store at request time.
// Posts are data, not site code: the content repo's publish action writes them to the R2 bucket
// bound as BLOG (blog/index.json, blog/posts/<slug>.json, blog/images/<slug>/<file>). Nothing here
// holds or calls an AI provider. Date rule: the index, RSS and sitemap list only posts dated on or
// before today (Isle of Man time); a post page is reachable by its URL whatever its date.
// Without a BLOG binding every blog URL is 404 and the sitemap lists the core pages only.
import {escapeHTML, renderMarkdown, IMAGE_FILE} from './markdown.mjs';

export const PREFIX = 'blog/';
// The page shell built by scripts/prepare.mjs; the Worker fills it and never serves it as-is.
export const BLOG_SHELL = '/assets/blog-page.html';
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_ZONE = 'Europe/Isle_of_Man';
// Owner, 24 Nov: the owner reads posts but does not verify them, so the line claims no editorial check.
export const AI_NOTE = 'Written with AI assistance.';
export const FEED_SIZE = 20;
const READ_PATH = /^\/read\/[A-Z][A-Z0-9]{1,11}\/[A-Za-z0-9_-]+\/\d{1,4}$/;
// The site's own View Article URLs percent-encode the identifier (/search?view=IMT%2FIMT-…).
const VIEW_PATH = /^\/search\?view=(?:[A-Za-z0-9_:/-]|%2F|%3A)+$/i;
// Core pages listed in the sitemap alongside visible posts.
export const SITEMAP_PAGES = ['/', '/publications', '/calendar', '/about', '/connect-ai', '/terms', '/privacy'];

// Tags become /blog?tag= links. A tag is words: letters, digits, hyphens, apostrophes, full stops and
// &, separated by single spaces, starting with a letter or digit, at most 40 characters ("St. John's",
// "Laxey & Lonan"). postMeta refuses any other tag, so the content check and the site agree and no
// tag is silently left out. Matching ignores case; a requested tag is trimmed and its spaces collapsed.
export const TAG = /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}'’.&-]| (?=[^ ])){0,39}$/u;
export const TAG_RULE = "use words of letters, digits, hyphens, apostrophes, full stops or &, with single spaces, at most 40 characters";
const tagKey = tag => tag.normalize('NFC').toLowerCase();
// A post's tags as links (one per tag, ignoring case). Empty when none.
function tagList(tags) {
  const seen = new Set(), items = tags.filter(tag => !seen.has(tagKey(tag)) && seen.add(tagKey(tag)))
    .map(tag => '<li><a href="/blog?tag=' + encodeURIComponent(tag) + '">' + escapeHTML(tag) + '</a></li>').join('');
  return items ? '<ul class="blog-tags" role="list" aria-label="Tags">' + items + '</ul>' : '';
}

export const isBlogPath = path => /^\/blog(?:\/|$)/.test(path) || path === '/sitemap.xml';

const realDate = value => {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
// Text that also goes into RSS must be valid XML: no C0 controls (other than tab and newlines),
// no U+FFFE/U+FFFF and no unpaired surrogates.
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max
  && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
const KEYS = new Set(['slug', 'title', 'date', 'summary', 'image', 'image_alt', 'updated', 'tags', 'author', 'ai_assisted', 'sources', 'body']);

// Strict check of one post's front matter (and body when present). Returns the normalised post or
// throws with the first problem. The content repo's validator applies the same rules before merge.
export function postMeta(raw, {body = false} = {}) {
  const fail = message => { throw new Error('blog post ' + (typeof raw?.slug === 'string' ? raw.slug : '?') + ': ' + message); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('not an object');
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) fail('unknown field ' + key);
  if (typeof raw.slug !== 'string' || raw.slug.length > 80 || !SLUG.test(raw.slug)) fail('slug');
  if (!text(raw.title, 120)) fail('title');
  if (!realDate(raw.date)) fail('date');
  if (!text(raw.summary, 300)) fail('summary');
  if (raw.updated !== undefined && (!realDate(raw.updated) || raw.updated < raw.date)) fail('updated');
  if (raw.image !== undefined && (typeof raw.image !== 'string' || !IMAGE_FILE.test(raw.image))) fail('image');
  if ((raw.image === undefined) !== (raw.image_alt === undefined) || (raw.image_alt !== undefined && !text(raw.image_alt, 300))) fail('image_alt');
  if (raw.tags !== undefined && (!Array.isArray(raw.tags) || raw.tags.length > 12)) fail('tags');
  for (const tag of raw.tags ?? []) if (typeof tag !== 'string' || !TAG.test(tag)) fail('tag ' + JSON.stringify(tag) + ': ' + TAG_RULE);
  if (raw.author !== undefined && !text(raw.author, 80)) fail('author');
  if (raw.ai_assisted !== undefined && typeof raw.ai_assisted !== 'boolean') fail('ai_assisted');
  if (!Array.isArray(raw.sources) || !raw.sources.length || raw.sources.length > 50) fail('sources');
  const sources = raw.sources.map(source => {
    const {url, label} = typeof source === 'string' ? {url: source} : source ?? {};
    if (typeof url !== 'string' || !(READ_PATH.test(url) || VIEW_PATH.test(url))) fail('source ' + JSON.stringify(url));
    if (label !== undefined && !text(label, 200)) fail('source label');
    return {url, label: label ?? sourceLabel(url)};
  });
  if (body && typeof raw.body !== 'string') fail('body');
  const {body: markdown, ...meta} = raw;
  return {...meta, author: raw.author ?? 'Manx Papers', ai_assisted: raw.ai_assisted ?? true, tags: raw.tags ?? [], sources,
    ...(body ? {body: markdown} : {})};
}

// "/read/IME/IME-1854-09-29/3" → "IME, 29 September 1854, page 3".
export function sourceLabel(url) {
  const read = /^\/read\/([A-Z0-9]+)\/[A-Z0-9]+[-_](\d{4}-\d{2}-\d{2})[^/]*\/(\d+)$/.exec(url);
  if (read && realDate(read[2])) return read[1] + ', ' + longDate(read[2]) + ', page ' + Number(read[3]);
  return url;
}

export function today(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'})
    .formatToParts(now).map(({type, value}) => [type, value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}
export const longDate = date => new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'}).format(new Date(date + 'T00:00:00Z'));
const rfc822 = date => new Date(date + 'T00:00:00Z').toUTCString();

// The listing: valid entries only, visible on or before today, newest first (then by title).
export function visiblePosts(index, day) {
  const posts = [];
  for (const raw of Array.isArray(index?.posts) ? index.posts : []) {
    try { posts.push(postMeta(raw)); } catch (error) { console.error(error.message); }
  }
  // One entry per slug among the visible ones (the first wins), so a future-dated duplicate never
  // hides a visible entry. The post page reads only blog/posts/<slug>.json anyway.
  const seen = new Set();
  return posts.filter(post => post.date <= day).filter(post => {
    if (!seen.has(post.slug)) return seen.add(post.slug);
    console.error('blog post ' + post.slug + ': duplicate index entry');
    return false;
  }).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
}

const timeTag = date => '<time datetime="' + date + '">' + longDate(date) + '</time>';

function headTags({title, description, url, image, imageAlt, type, published, updated, noindex}) {
  return [
    '<meta name="description" content="' + escapeHTML(description) + '" />',
    '<link rel="canonical" href="' + escapeHTML(url) + '" />',
    '<link rel="alternate" type="application/rss+xml" title="' + FEED_TITLE + '" href="/blog/feed.xml" />',
    ...(noindex ? ['<meta name="robots" content="noindex, nofollow" />'] : []),
    '<meta property="og:site_name" content="Manx Papers" />',
    '<meta property="og:type" content="' + type + '" />',
    '<meta property="og:title" content="' + escapeHTML(title) + '" />',
    '<meta property="og:description" content="' + escapeHTML(description) + '" />',
    '<meta property="og:url" content="' + escapeHTML(url) + '" />',
    '<meta property="og:image" content="' + escapeHTML(image) + '" />',
    '<meta property="og:image:alt" content="' + escapeHTML(imageAlt) + '" />',
    '<meta property="og:locale" content="en_GB" />',
    ...(published ? ['<meta property="article:published_time" content="' + published + '" />'] : []),
    ...(updated ? ['<meta property="article:modified_time" content="' + updated + '" />'] : []),
    '<meta name="twitter:card" content="summary_large_image" />',
  ].join('\n    ');
}

export const DEFAULT_IMAGE = '/assets/brand/social-card.png';
// Owner, 24 Nov: the blog is "Stories from the Archive" (the address stays /blog).
export const BLOG_NAME = 'Stories from the Archive';
// The short name, as in the header link and the posts' breadcrumb.
export const BLOG_LINK = 'Stories';
const FEED_TITLE = 'Manx Papers: ' + BLOG_NAME;
const BLOG_DESCRIPTION = 'Stories from the Manx Papers archive of Isle of Man newspapers.';
// Owner's own words, 24 Nov: under the heading on the index and tag views, not on posts. Introductory
// text in a plain div, not a landmark: an aside inside main fails axe landmark-complementary-is-top-level.
export const BLOG_CALLOUT = '<div class="blog-callout">\n'
  + '<p>Each story explores a single topic. It was written by AI, using the Manx Papers archive, with some background from other sources.</p>\n'
  + "<p>Newspapers are contemporary, which is their advantage. But they can carry the mistakes and biases of their day, and our archive isn't complete, so these stories may contain errors and require verification and expansion.</p>\n"
  + '<p>Want to explore your own topic? <a href="/connect-ai">Connect your AI assistant</a>.</p>\n'
  + '</div>\n';
const DEFAULT_IMAGE_ALT = 'Manx Papers: The Isle of Man in Print';

// The listing, or with `tag` the posts carrying that tag (the spelling shown is the newest post's).
// Each card is one link: the title's ::after covers the card, and the tag links sit above it.
export function renderIndex(posts, origin, tag) {
  const items = posts.map(post => '<li><article class="blog-card" aria-labelledby="post-' + post.slug + '">'
    + '<h2 id="post-' + post.slug + '"><a class="blog-card-link" href="/blog/' + post.slug + '">' + escapeHTML(post.title) + '</a></h2>'
    + '<p class="blog-byline">' + timeTag(post.date) + '</p>'
    + '<p>' + escapeHTML(post.summary) + '</p>' + tagList(post.tags) + '</article></li>').join('');
  const list = items ? '<ul class="blog-list" role="list">' + items + '</ul>' : '<p>There are no stories yet.</p>';
  if (tag) return {
    title: escapeHTML('Stories tagged ‘' + tag + '’'),
    // A filtered view of /blog: never indexed, and canonical to the blog itself.
    head: headTags({title: 'Manx Papers: Stories tagged ' + tag, description: 'Manx Papers stories tagged ' + tag + '.',
      url: origin + '/blog', image: origin + DEFAULT_IMAGE, imageAlt: DEFAULT_IMAGE_ALT, type: 'website', noindex: true}),
    content: '<h1>Stories tagged ‘' + escapeHTML(tag) + '’</h1>\n' + BLOG_CALLOUT + '<p class="blog-intro"><a href="/blog">All stories</a></p>\n' + list,
  };
  return {
    title: BLOG_NAME,
    head: headTags({title: FEED_TITLE, description: BLOG_DESCRIPTION,
      url: origin + '/blog', image: origin + DEFAULT_IMAGE, imageAlt: DEFAULT_IMAGE_ALT, type: 'website'}),
    content: '<h1>' + BLOG_NAME + '</h1>\n' + BLOG_CALLOUT + '<p class="blog-intro">Every story links to the newspaper pages it draws on. '
      + '<a href="/blog/feed.xml">Follow by RSS</a>.</p>\n' + list,
  };
}

export function renderPost(post, origin, day) {
  const {html} = renderMarkdown(post.body, {slug: post.slug});
  const scheduled = post.date > day;
  const image = post.image ? origin + '/blog/images/' + post.slug + '/' + post.image : origin + DEFAULT_IMAGE;
  const sources = post.sources.map(s => '<li><a href="' + escapeHTML(s.url) + '">' + escapeHTML(s.label) + '</a></li>').join('');
  return {
    title: escapeHTML(post.title),
    head: headTags({title: post.title, description: post.summary, url: origin + '/blog/' + post.slug, image,
      imageAlt: post.image ? post.image_alt : DEFAULT_IMAGE_ALT, type: 'article', published: post.date, updated: post.updated, noindex: scheduled}),
    content: '<div class="blog-post-nav">\n<nav class="blog-breadcrumb" aria-label="Breadcrumb"><a href="/blog">' + BLOG_LINK + '</a></nav>\n'
      + tagList(post.tags) + '</div>\n<article class="blog-post" aria-labelledby="post-title">\n<div class="blog-post-head">\n'
      + '<h1 id="post-title">' + escapeHTML(post.title) + '</h1>\n'
      + '<p class="blog-byline">By ' + escapeHTML(post.author) + ' · ' + timeTag(post.date)
      + (post.updated ? ' · Updated ' + timeTag(post.updated) : '') + '</p>\n'
      + (scheduled ? '<p class="blog-scheduled" role="note">Scheduled: this post is not listed in ' + BLOG_NAME + ' until ' + longDate(post.date) + '.</p>\n' : '')
      + '</div>\n<div class="blog-body">\n' + html + '\n</div>\n<div class="blog-post-footer">\n'
      + (post.ai_assisted ? '<p class="blog-ai-note">' + AI_NOTE + '</p>\n' : '')
      + '<h2>Sources in the archive</h2>\n<ul class="blog-sources">' + sources + '</ul>\n</div>\n</article>',
  };
}

const xml = value => escapeHTML(value);
export function renderFeed(posts, origin) {
  const items = posts.slice(0, FEED_SIZE).map(post => '<item><title>' + xml(post.title) + '</title><link>' + origin + '/blog/' + post.slug
    + '</link><guid isPermaLink="true">' + origin + '/blog/' + post.slug + '</guid><pubDate>' + rfc822(post.date)
    + '</pubDate><description>' + xml(post.summary) + '</description></item>').join('');
  return '<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>'
    + '<title>' + FEED_TITLE + '</title><link>' + origin + '/blog</link><description>' + BLOG_DESCRIPTION + '</description>'
    + '<language>en-gb</language><atom:link href="' + origin + '/blog/feed.xml" rel="self" type="application/rss+xml"/>'
    + (posts[0] ? '<lastBuildDate>' + rfc822(posts[0].updated ?? posts[0].date) + '</lastBuildDate>' : '')
    + items + '</channel></rss>\n';
}

export function renderSitemap(posts, origin) {
  const url = (path, lastmod) => '<url><loc>' + origin + path + '</loc>' + (lastmod ? '<lastmod>' + lastmod + '</lastmod>' : '') + '</url>';
  return '<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    + SITEMAP_PAGES.map(path => url(path)).join('')
    + (posts ? url('/blog', posts.map(post => post.updated ?? post.date).sort().at(-1)) + posts.map(post => url('/blog/' + post.slug, post.updated ?? post.date)).join('') : '')
    + '</urlset>\n';
}

const IMAGE_TYPES = {jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp'};

// Returns a Response for a blog URL, or null when the path is not the blog's.
// `respond(body, init)` adds the site's security headers; `page({title, head, content})` fills the
// shell with markup that is already escaped (title included).
export async function handleBlog(request, env, {respond, page, now = new Date()}) {
  const url = new URL(request.url), path = url.pathname, store = env?.BLOG;
  if (!isBlogPath(path)) return null;
  // The one query allowed is a single ?tag= on /blog, in the tag charset.
  const params = [...url.searchParams];
  const tag = path === '/blog' && params.length === 1 && params[0][0] === 'tag' ? params[0][1].trim().replace(/ +/g, ' ') : null;
  if (url.search && !(tag !== null && TAG.test(tag))) return respond('Not found', {status: 404});
  const head = request.method === 'HEAD';
  const send = (body, type, init = {}) => respond(head ? null : body, {...init, headers: {'Content-Type': type, ...init.headers}});
  if (path === '/blog/') return respond(null, {status: 308, headers: {Location: '/blog'}});
  const hasStore = store && typeof store.get === 'function';
  const origin = url.origin, day = today(now);
  const readIndex = async () => {
    const object = await store.get(PREFIX + 'index.json');
    return object ? visiblePosts(await object.json(), day) : [];
  };
  try {
    if (path === '/sitemap.xml') {
      // The core pages never depend on the blog store: on any store or index failure, list them alone.
      let posts = null;
      if (hasStore) try { posts = await readIndex(); } catch (error) { console.error('blog store: ' + (error?.message ?? error)); }
      return send(renderSitemap(posts, origin), 'application/xml; charset=utf-8');
    }
    if (!hasStore) return respond('Not found', {status: 404});
    if (path === '/blog' && tag !== null) {
      // Visible posts only; a tag no visible post carries is Not found.
      const key = tagKey(tag), posts = (await readIndex()).filter(post => post.tags.some(t => tagKey(t) === key));
      if (!posts.length) return respond('Not found', {status: 404});
      return send(await page(renderIndex(posts, origin, posts[0].tags.find(t => tagKey(t) === key))), 'text/html; charset=utf-8');
    }
    if (path === '/blog') { const view = renderIndex(await readIndex(), origin); return send(await page(view), 'text/html; charset=utf-8'); }
    if (path === '/blog/feed.xml') return send(renderFeed(await readIndex(), origin), 'application/rss+xml; charset=utf-8');
    const image = /^\/blog\/images\/([a-z0-9-]{1,80})\/([^/]+)$/.exec(path);
    if (image && SLUG.test(image[1]) && IMAGE_FILE.test(image[2])) {
      const object = await store.get(PREFIX + 'images/' + image[1] + '/' + image[2]);
      if (!object) return respond('Not found', {status: 404});
      // Private: the site sits behind Cloudflare Access until go-live, so no shared cache may store it.
      return respond(head ? null : object.body, {headers: {'Content-Type': IMAGE_TYPES[image[2].split('.').pop()],
        'Cache-Control': 'private, max-age=3600', ...(object.httpEtag ? {ETag: object.httpEtag} : {})}});
    }
    const slug = /^\/blog\/([a-z0-9-]{1,80})$/.exec(path)?.[1];
    if (!slug || !SLUG.test(slug)) return respond('Not found', {status: 404});
    const object = await store.get(PREFIX + 'posts/' + slug + '.json');
    if (!object) return respond('Not found', {status: 404});
    let post;
    try { post = postMeta(await object.json(), {body: true}); } catch (error) { console.error(error.message); return respond('Not found', {status: 404}); }
    if (post.slug !== slug) return respond('Not found', {status: 404});
    return send(await page(renderPost(post, origin, day)), 'text/html; charset=utf-8');
  } catch (error) {
    console.error('blog store: ' + (error?.message ?? error));
    return respond('Stories are temporarily unavailable.', {status: 503, headers: {'Retry-After': '60'}});
  }
}

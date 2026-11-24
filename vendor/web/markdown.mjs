// Control #244: a small, safe Markdown subset for blog posts. Raw HTML is never passed through:
// every character of source text is escaped, and only the tags below are generated. Links and
// images are limited to same-site paths (links may also be https:). The renderer reports what it
// dropped in `problems`, so the content repo's validator can refuse a post the site would alter.
//
// Blocks: ## to #### headings (a single # becomes ##: the page title is the only h1), paragraphs,
// - / * / 1. lists, > quotes, --- rules, and a figure for an image alone on its line:
// ![alt](src "optional caption"). Inline: `code`, [text](href), **strong**, *em* / _em_.
import {isMediaPath} from './proxy.mjs';

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
  if (src.startsWith('/media/') && isMediaPath(src)) return src;
  return null;
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
export function renderMarkdown(source, {slug = ''} = {}) {
  const problems = [];
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let paragraph = [], list = null, quote = [];
  const flushParagraph = () => { if (paragraph.length) html.push('<p>' + inline(paragraph.join(' '), problems) + '</p>'); paragraph = []; };
  const flushList = () => { if (list) html.push('<' + list.tag + '>' + list.items.map(i => '<li>' + inline(i, problems) + '</li>').join('') + '</' + list.tag + '>'); list = null; };
  const flushQuote = () => {
    if (!quote.length) return;
    const nested = renderMarkdown(quote.join('\n'), {slug});
    problems.push(...nested.problems);
    html.push('<blockquote>' + nested.html + '</blockquote>');
    quote = [];
  };
  const flush = () => { flushParagraph(); flushList(); flushQuote(); };
  for (const raw of lines) {
    const line = raw.trimEnd();
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
    else if ((m = FIGURE.exec(line.trim()))) {
      flush();
      const src = imageSrc(m[2], slug);
      if (!src) problems.push('image not allowed: ' + m[2]);
      else if (!m[1].trim()) problems.push('image needs alt text: ' + m[2]);
      else html.push('<figure><img src="' + escapeHTML(src) + '" alt="' + escapeHTML(m[1].trim()) + '" loading="lazy" decoding="async">'
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
  flush();
  return {html: html.join('\n'), problems};
}

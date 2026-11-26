// Control #244: validate the content repo and build the content store layout the Web Worker reads.
// The post rules are the Worker's own (vendor/web, pinned by hash), so a post that passes here is
// served unchanged, and a post the Worker would alter or refuse fails here, before merge.
import {readFile, readdir, stat, mkdir, writeFile, copyFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {parsePost} from './frontmatter.mjs';
import {postMeta, SLUG} from '../vendor/web/blog.mjs';
import {renderMarkdown, IMAGE_FILE} from '../vendor/web/markdown.mjs';
import {sectionURL, viewURL} from '../vendor/web/clipping.mjs';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const unescapeHTML = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'"})[e]);
// An archive link is a rendered link (not text in a code span) to a path the Worker accepts as a
// post source: a /read/ page or an Article (/items/, /sections/ or /search?view=). postMeta is the
// Worker's own rule for that.
const SOURCE_PROBE = {title: 'x', date: '2026-01-01', summary: 'x', slug: 'x'};
export function archiveHref(href) {
  try { postMeta({...SOURCE_PROBE, sources: [href]}); return true; } catch { return false; }
}
// The site's copy-link buttons give absolute addresses: https://beta.manxpapers.com/items/<Item id>
// for an Article. A pasted address is stored as the site path: the site part (Beta, live or www) is
// removed. Every Article link is stored as its Article page (web#189), the address the site itself
// links and copies: /items/<Item id>, or /sections/<Section id> for a section, which opens its
// Article at that section. An older View Article address (/search?view=<id>), which the site
// redirects to that page, is stored as the page too. An ID the page can't take is left as it is.
const SITE = /^https:\/\/(?:beta\.|www\.)?manxpapers\.com(?=\/)/;
const ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const ARTICLE = /^\/(?:items|sections)\/(.+)$/, VIEW = /^\/search\?view=([^&#]+)$/;
export function sitePath(url) {
  if (typeof url !== 'string') return url;
  const path = url.replace(SITE, ''), m = ARTICLE.exec(path) ?? VIEW.exec(path);
  if (!m) return path;
  let id;
  try { id = decodeURIComponent(m[1]); } catch { return path; }
  return ID.test(id) && id.length <= 200 ? viewURL(id) : path;
}
// The same for link and image targets in the text: ](https://beta.manxpapers.com/…), ](/items/…) and
// ](/search?view=…).
const BODY_LINK = /\]\((https:\/\/(?:beta\.|www\.)?manxpapers\.com\/[^\s)]*|\/(?:items|sections)\/[A-Za-z0-9_/-]+|\/search\?view=[^\s)&#]+)(?=[\s)])/g;
// web#183: a clipping names its section after section:. The section's copy-link address pasted there
// (section:https://beta.manxpapers.com/sections/<id>, or section:/sections/<id>) is stored as section:<id>.
const CLIPPING_LINK = /\]\(section:(?:https:\/\/(?:beta\.|www\.)?manxpapers\.com)?\/sections\/([A-Za-z0-9_/-]+)(?=[\s)?])/g;
export const bodyPaths = body => body.replace(BODY_LINK, (_, url) => '](' + sitePath(url)).replace(CLIPPING_LINK, '](section:$1');
const MAGIC = {
  jpg: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
MAGIC.jpeg = MAGIC.jpg;

const list = async dir => { try { return await readdir(dir, {withFileTypes: true}); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };

// Checks one post's text. Returns {post, figures, clippings, errors, warnings}; post is the stored
// JSON when valid. Warnings (a source without a label) are reported but don't fail the check.
export function checkPost(slug, source) {
  const errors = [], warnings = [];
  if (slug.length > 80 || !SLUG.test(slug)) return {warnings: [], errors: ['file name must be lower-case words joined by hyphens (a-z, 0-9), at most 80 characters']};
  let parsed;
  try { parsed = parsePost(source); } catch (error) { return {warnings: [], errors: ['front matter: ' + error.message]}; }
  const {data} = parsed, body = bodyPaths(parsed.body);
  if (Object.hasOwn(data, 'slug') && data.slug !== slug) errors.push('slug in front matter differs from the file name');
  if (Object.hasOwn(data, 'body')) errors.push('body is not a front-matter field');
  // Pasted copy-link addresses are stored as site paths (see sitePath).
  if (Array.isArray(data.sources)) data.sources = data.sources.map(source => typeof source === 'string' ? sitePath(source)
    : source && typeof source === 'object' && !Array.isArray(source) ? {...source, url: sitePath(source.url)} : source);
  const raw = {...data, slug, body};
  try { postMeta(raw, {body: true}); } catch (error) { errors.push(error.message.replace(/^blog post [^:]+: /, 'front matter: ')); }
  if (!body.trim()) errors.push('the post has no text');
  // Without a label an Article shows its address, and a page only "IME, 29 September 1854, page 3",
  // not the headline (README: "Paper, date: headline").
  if (Array.isArray(data.sources)) for (const source of data.sources) {
    const url = typeof source === 'string' ? source : source?.url;
    if (typeof url === 'string' && (typeof source === 'string' || source.label === undefined))
      warnings.push('source ' + url + ' has no label; add label: "Paper, date: headline"');
  }
  // Links and figures are read from what the Worker's renderer actually emits, so every form it
  // accepts (a bare file name, /blog/images/<slug>/<file>, inside a quote) is checked.
  const {html, problems, clippings} = renderMarkdown(body, {slug});
  for (const problem of problems) errors.push('text: ' + problem);
  const hrefs = [...html.matchAll(/<a href="([^"]*)">/g)].map(m => unescapeHTML(m[1]));
  if (!hrefs.some(archiveHref)) errors.push('text: link at least one claim to the archive, e.g. [the report](/read/IME/IME-1854-09-29/3)');
  const figures = [];
  for (const [, src] of html.matchAll(/<img src="([^"]*)"/g)) {
    const m = /^\/blog\/images\/([^/]+)\/([^/]+)$/.exec(unescapeHTML(src));
    if (m && m[1] === slug && IMAGE_FILE.test(m[2])) figures.push(m[2]);
    // Archive page images (/media/…) never get this far: the renderer refuses them and points to
    // section: clippings (web#183), which the Worker draws from the archive and nothing here stores.
    else errors.push('text: image ' + unescapeHTML(src) + ' is not in images/' + slug + '/');
  }
  return {post: errors.length ? null : raw, figures, clippings, errors, warnings};
}

// web#183: each clipping is looked up in the archive, as the site will look it up, so the writer hears
// before merge about a section that isn't there or a highlight that finds nothing. Highlights match
// the text as the archive read it (OCR), not the true spelling, so a correctly spelt word can miss.
// These are warnings, never silent: when the archive can't be asked, that is a warning too.
// Each lookup gets at most 15 s, and all of them share one deadline (60 s for the whole check), so an
// archive that hangs rather than refusing can't hold the job until CI times it out. Lookups left when
// the time is up become "couldn't check" warnings. A lookup that ignores its abort signal is still
// abandoned at its time limit.
const SECTION_TIMEOUT_MS = 15000;
// The archive the check asks. Since web 8892657 (Control #264) the site takes its API origin from its
// deployment's settings, so sectionURL needs it passed in. Posts are checked against Beta's API, which
// serves the same archive as live; pass apiOrigin to ask another.
export const ARCHIVE_API_ORIGIN = 'https://api-beta.manxpapers.com';
export const ARCHIVE_BUDGET_MS = 60000;
const couldNot = (clip, why) => 'clipping ' + clip.id + ": couldn't check it in the archive (" + why + '); check it on the preview';
export async function checkClippings(clippings, fetchSection = fetch, {deadline = Date.now() + ARCHIVE_BUDGET_MS, apiOrigin = ARCHIVE_API_ORIGIN} = {}) {
  const warnings = [], seen = new Set();
  for (const clip of clippings) {
    const url = sectionURL(clip.id, clip.highlight, apiOrigin);
    if (seen.has(url)) continue;
    seen.add(url);
    const left = deadline - Date.now();
    if (left <= 0) { warnings.push(couldNot(clip, 'the archive check ran out of time')); continue; }
    const limit = Math.min(SECTION_TIMEOUT_MS, left);
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => { timer = setTimeout(() => {
      const error = new Error('no answer within ' + Math.ceil(limit / 1000) + ' s');
      controller.abort(error);
      reject(error);
    }, limit); });
    let response, doc;
    try {
      response = await Promise.race([timedOut, fetchSection(url, {headers: {accept: 'application/json'}, signal: controller.signal})]);
      if (response.ok) doc = await Promise.race([timedOut, response.json()]);
    } catch (error) {
      warnings.push(couldNot(clip, error?.message ?? error));
      continue;
    } finally { clearTimeout(timer); }
    if (response.status === 404) { warnings.push('clipping ' + clip.id + ": the archive has no such section; the site will say the clipping can't be shown"); continue; }
    if (!response.ok || doc?.section?.id !== clip.id) { warnings.push(couldNot(clip, 'status ' + response.status)); continue; }
    const block = doc.section.source_block_id;
    if (clip.highlight && !(doc.hit_geometry ?? []).some(hit => hit?.block_id === block))
      warnings.push('clipping ' + clip.id + ': highlight "' + clip.highlight + '" matches nothing in the text the archive read for this section,'
        + ' so nothing will be highlighted. Highlights match the recognised text (see "Read the text"), not the true spelling.');
  }
  return warnings;
}

// Validates the whole repository. Returns {posts, images, errors, warnings}, each "path: message".
// archive: false skips the archive lookups (the publish build, which runs after the check passed).
export async function validate(root, {archive = true, fetchSection = fetch, archiveBudgetMs = ARCHIVE_BUDGET_MS, apiOrigin = ARCHIVE_API_ORIGIN} = {}) {
  const errors = [], warnings = [], posts = [], images = [];
  const slugs = new Set();
  for (const entry of await list(join(root, 'posts'))) {
    const path = 'posts/' + entry.name;
    if (entry.name === '.gitkeep') continue;
    if (!entry.isFile() || !entry.name.endsWith('.md')) { errors.push(path + ': only .md post files belong in posts/'); continue; }
    const slug = entry.name.slice(0, -3);
    const result = checkPost(slug, await readFile(join(root, path), 'utf8'));
    for (const error of result.errors) errors.push(path + ': ' + error);
    for (const warning of result.warnings) warnings.push(path + ': ' + warning);
    slugs.add(slug);
    if (result.post) posts.push({...result, slug, path});
  }
  for (const folder of await list(join(root, 'images'))) {
    if (folder.name === '.gitkeep') continue;
    const base = 'images/' + folder.name;
    if (!folder.isDirectory()) { errors.push(base + ': images go in images/<post-file-name>/'); continue; }
    if (!slugs.has(folder.name)) errors.push(base + ': no post posts/' + folder.name + '.md');
    for (const file of await list(join(root, base))) {
      const path = base + '/' + file.name;
      if (!file.isFile() || !IMAGE_FILE.test(file.name)) { errors.push(path + ': only .jpg, .jpeg, .png or .webp files with simple names'); continue; }
      const size = (await stat(join(root, path))).size;
      if (size > MAX_IMAGE_BYTES) { errors.push(path + ': larger than 5 MB'); continue; }
      const bytes = await readFile(join(root, path));
      if (!MAGIC[file.name.split('.').pop()](bytes)) { errors.push(path + ': contents do not match the file extension'); continue; }
      images.push({slug: folder.name, name: file.name, path});
    }
  }
  const deadline = Date.now() + archiveBudgetMs;
  if (archive) for (const {clippings, path} of posts)
    for (const warning of await checkClippings(clippings, fetchSection, {deadline, apiOrigin})) warnings.push(path + ': ' + warning);
  for (const {slug, post, figures, path} of posts) {
    const have = new Set(images.filter(i => i.slug === slug).map(i => i.name));
    for (const name of [...(post.image ? [post.image] : []), ...figures])
      if (!have.has(name)) errors.push(path + ': image ' + name + ' is not in images/' + slug + '/');
  }
  return {posts: posts.map(p => p.post), images, errors, warnings};
}

// Writes the content store layout under out/blog: posts/<slug>.json, images/<slug>/<file>, index.json.
export async function build(root, out) {
  const {posts, images, errors} = await validate(root, {archive: false});
  if (errors.length) throw new Error('Content is not valid:\n' + errors.join('\n'));
  await rm(join(out, 'blog'), {recursive: true, force: true});
  await mkdir(join(out, 'blog', 'posts'), {recursive: true});
  for (const post of posts) await writeFile(join(out, 'blog', 'posts', post.slug + '.json'), JSON.stringify(post));
  for (const image of images) {
    await mkdir(join(out, 'blog', 'images', image.slug), {recursive: true});
    await copyFile(join(root, image.path), join(out, 'blog', 'images', image.slug, image.name));
  }
  const index = posts.map(({body, ...meta}) => meta)
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  await writeFile(join(out, 'blog', 'index.json'), JSON.stringify({posts: index}));
  return {posts: posts.length, images: images.length};
}

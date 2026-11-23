// Control #244: validate the content repo and build the content store layout the Web Worker reads.
// The post rules are the Worker's own (vendor/web, pinned by hash), so a post that passes here is
// served unchanged, and a post the Worker would alter or refuse fails here, before merge.
import {readFile, readdir, stat, mkdir, writeFile, copyFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {parsePost} from './frontmatter.mjs';
import {postMeta, SLUG} from '../vendor/web/blog.mjs';
import {renderMarkdown, IMAGE_FILE} from '../vendor/web/markdown.mjs';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const unescapeHTML = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'"})[e]);
// An archive link is a rendered link (not text in a code span) to a path the Worker accepts as a
// post source: a /read/ page or a /search?view= Article. postMeta is the Worker's own rule for that.
const SOURCE_PROBE = {title: 'x', date: '2026-01-01', summary: 'x', slug: 'x'};
export function archiveHref(href) {
  try { postMeta({...SOURCE_PROBE, sources: [href]}); return true; } catch { return false; }
}
const MAGIC = {
  jpg: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
MAGIC.jpeg = MAGIC.jpg;

const list = async dir => { try { return await readdir(dir, {withFileTypes: true}); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };

// Checks one post's text. Returns {post, figures, errors, warnings}; post is the stored JSON when
// valid. Warnings (a source without a label) are reported but don't fail the check.
export function checkPost(slug, source) {
  const errors = [], warnings = [];
  if (slug.length > 80 || !SLUG.test(slug)) return {warnings: [], errors: ['file name must be lower-case words joined by hyphens (a-z, 0-9), at most 80 characters']};
  let parsed;
  try { parsed = parsePost(source); } catch (error) { return {warnings: [], errors: ['front matter: ' + error.message]}; }
  const {data, body} = parsed;
  if (Object.hasOwn(data, 'slug') && data.slug !== slug) errors.push('slug in front matter differs from the file name');
  if (Object.hasOwn(data, 'body')) errors.push('body is not a front-matter field');
  const raw = {...data, slug, body};
  try { postMeta(raw, {body: true}); } catch (error) { errors.push(error.message.replace(/^blog post [^:]+: /, 'front matter: ')); }
  if (!body.trim()) errors.push('the post has no text');
  // Without a label the source list shows the bare address (README: "Paper, date: headline").
  if (Array.isArray(data.sources)) for (const source of data.sources)
    if (typeof source === 'string') warnings.push('source ' + source + ' has no label; use url: and label: "Paper, date: headline"');
  // Links and figures are read from what the Worker's renderer actually emits, so every form it
  // accepts (a bare file name, /blog/images/<slug>/<file>, inside a quote) is checked.
  const {html, problems} = renderMarkdown(body, {slug});
  for (const problem of problems) errors.push('text: ' + problem);
  const hrefs = [...html.matchAll(/<a href="([^"]*)">/g)].map(m => unescapeHTML(m[1]));
  if (!hrefs.some(archiveHref)) errors.push('text: link at least one claim to the archive, e.g. [the report](/read/IME/IME-1854-09-29/3)');
  const figures = [];
  for (const [, src] of html.matchAll(/<img src="([^"]*)"/g)) {
    const m = /^\/blog\/images\/([^/]+)\/([^/]+)$/.exec(unescapeHTML(src));
    if (m && m[1] === slug && IMAGE_FILE.test(m[2])) figures.push(m[2]);
    // The Worker can show archive page images, but their reuse rights are still open (Control #244).
    else if (unescapeHTML(src).startsWith('/media/')) errors.push('text: archive page images (' + unescapeHTML(src) + ") aren't allowed in posts yet; use an image in images/" + slug + '/');
    else errors.push('text: image ' + unescapeHTML(src) + ' is not in images/' + slug + '/');
  }
  return {post: errors.length ? null : raw, figures, errors, warnings};
}

// Validates the whole repository. Returns {posts, images, errors, warnings}, each "path: message".
export async function validate(root) {
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
  for (const {slug, post, figures, path} of posts) {
    const have = new Set(images.filter(i => i.slug === slug).map(i => i.name));
    for (const name of [...(post.image ? [post.image] : []), ...figures])
      if (!have.has(name)) errors.push(path + ': image ' + name + ' is not in images/' + slug + '/');
  }
  return {posts: posts.map(p => p.post), images, errors, warnings};
}

// Writes the content store layout under out/blog: posts/<slug>.json, images/<slug>/<file>, index.json.
export async function build(root, out) {
  const {posts, images, errors} = await validate(root);
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

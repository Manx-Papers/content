import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {parsePost} from '../scripts/frontmatter.mjs';
import {checkPost, validate, build} from '../scripts/content.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const good = (extra = '', body = 'The wheel [turned](/read/IME/IME-1854-09-29/3).') =>
  '---\ntitle: "The Laxey Wheel"\ndate: 2026-11-01\nsummary: "How the papers reported it."\nsources:\n  - /read/IME/IME-1854-09-29/3\n' + extra + '---\n' + body + '\n';

async function repo(files) {
  const dir = await mkdtemp(join(tmpdir(), 'content-'));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), {recursive: true});
    await writeFile(join(dir, path), contents);
  }
  return dir;
}

test('the vendored Web Worker rules are the pinned copies', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'vendor/web/VENDOR.json'), 'utf8'));
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual((await readdir(join(root, 'vendor/web'))).filter(f => f.endsWith('.mjs')).sort(), Object.keys(manifest.files).sort());
  for (const [name, hash] of Object.entries(manifest.files))
    assert.equal(createHash('sha256').update(await readFile(join(root, 'vendor/web', name))).digest('hex'), hash, name);
});

test('front matter: the template subset, with strict errors outside it', () => {
  const {data, body} = parsePost('---\r\ntitle: "A \\"quoted\\" # title"\r\ndate: 2026-11-01 # comment\r\nai_assisted: false\r\ntags: [industry, "Laxey, IOM"]\r\nauthor: \'O\'\'Brien\'\r\nsources:\r\n  - /read/IME/IME-1854-09-29/3\r\n  - url: /search?view=IME%2Fx\r\n    label: "Report"\r\n---\r\n\r\nBody\r\n');
  assert.deepEqual(data, {title: 'A "quoted" # title', date: '2026-11-01', ai_assisted: false, tags: ['industry', 'Laxey, IOM'], author: "O'Brien",
    sources: ['/read/IME/IME-1854-09-29/3', {url: '/search?view=IME%2Fx', label: 'Report'}]});
  assert.equal(body, 'Body\n');
  for (const [bad, message] of [
    ['title: x\n', /front matter must start/],
    ['---\ntitle: "x\n---\n', /double-quoted/],
    ['---\ntitle: x\ntitle: y\n---\n', /duplicate key title/],
    ['---\n  title: x\n---\n', /unexpected indentation/],
    ['---\ntitle: {a: 1}\n---\n', /quote this value/],
    ['---\ntitle:\n---\n', /has no value/],
    ['---\ntitle: ~\n---\n', /empty value/],
    ['---\nsources:\n  oops\n---\n', /list item/],
    ['---\nTitle: x\n---\n', /expected "key: value"/],
  ]) assert.throws(() => parsePost(bad), message, bad);
});

test('the post template passes the same checks as the Worker', async () => {
  const {post, errors, figures} = checkPost('laxey-wheel', await readFile(join(root, 'templates/post.md'), 'utf8'));
  assert.deepEqual(errors, []);
  assert.equal(post.slug, 'laxey-wheel');
  assert.deepEqual(figures, ['laxey-wheel.jpg']);
});

test('posts the Worker would alter or refuse fail before merge', () => {
  const cases = {
    'no archive link': [good('', 'Plain text with [a link](https://www.gov.im/).'), /link at least one claim to the archive/],
    'raw HTML': [good('', '<script>x</script> [a](/read/IME/IME-1854-09-29/3)'), /raw HTML/],
    'unsafe link': [good('', '[a](/read/IME/IME-1854-09-29/3) [b](javascript:alert(1))'), /link not allowed/],
    'quoted unsafe link': [good('', '[a](/read/IME/IME-1854-09-29/3)\n\n> [b](http://example.com/)'), /link not allowed/],
    'top-level heading': [good('', '# Big\n\n[a](/read/IME/IME-1854-09-29/3)'), /use ##/],
    'image without alt': [good('', '[a](/read/IME/IME-1854-09-29/3)\n\n![](x.jpg)'), /alt text/],
    'remote image': [good('', '[a](/read/IME/IME-1854-09-29/3)\n\n![x](https://example.com/x.jpg)'), /image not allowed/],
    'external source': [good().replace('/read/IME/IME-1854-09-29/3\n', 'https://example.com/\n'), /source/],
    'unknown field': [good('draft: true\n'), /unknown field draft/],
    'impossible date': [good().replace('2026-11-01', '2026-02-30'), /date/],
    'slug mismatch': [good('slug: other\n'), /differs from the file name/],
    'empty body': [good('', ''), /no text/],
  };
  for (const [name, [source, message]] of Object.entries(cases)) {
    const {errors} = checkPost('laxey-wheel', source);
    assert.ok(errors.some(e => message.test(e)), name + ': ' + errors.join(' | '));
  }
  assert.match(checkPost('Laxey_Wheel', good()).errors[0], /file name/);
  assert.deepEqual(checkPost('laxey-wheel', good()).errors, []);
});

test('repository checks: stray files, orphan or mismatched images, missing images, size', async () => {
  const dir = await repo({
    'posts/laxey-wheel.md': good('image: wheel.jpg\nimage_alt: "The wheel"\n', '[a](/read/IME/IME-1854-09-29/3)\n\n![Fig](figure.png)\n\n![Gone](missing.jpg)'),
    'posts/notes.txt': 'x',
    'images/laxey-wheel/wheel.jpg': JPEG,
    'images/laxey-wheel/figure.png': PNG,
    'images/laxey-wheel/fake.png': JPEG,
    'images/laxey-wheel/logo.svg': '<svg/>',
    'images/old-post/a.jpg': JPEG,
    'images/stray.jpg': JPEG,
  });
  try {
    const {errors} = await validate(dir);
    const expect = ['posts/notes.txt: only .md', 'images/laxey-wheel/fake.png: contents do not match', 'images/laxey-wheel/logo.svg: only .jpg',
      'images/old-post: no post', 'images/stray.jpg: images go in', 'posts/laxey-wheel.md: image missing.jpg is not in'];
    for (const prefix of expect) assert.ok(errors.some(e => e.startsWith(prefix)), prefix + ' in ' + errors.join(' | '));
    assert.equal(errors.length, expect.length, errors.join(' | '));
    await writeFile(join(dir, 'images/laxey-wheel/big.jpg'), Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]));
    assert.ok((await validate(dir)).errors.some(e => e === 'images/laxey-wheel/big.jpg: larger than 5 MB'));
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('build writes the store layout the Worker reads; invalid content builds nothing', async () => {
  const dir = await repo({
    'posts/laxey-wheel.md': good('image: wheel.jpg\nimage_alt: "The wheel"\n'),
    'posts/christmas-1900.md': good().replace('2026-11-01', '2026-12-25').replace('The Laxey Wheel', 'Christmas'),
    'posts/.gitkeep': '',
    'images/laxey-wheel/wheel.jpg': JPEG,
  });
  const out = await mkdtemp(join(tmpdir(), 'content-out-'));
  try {
    assert.deepEqual(await build(dir, out), {posts: 2, images: 1});
    const index = JSON.parse(await readFile(join(out, 'blog/index.json'), 'utf8'));
    assert.deepEqual(index.posts.map(p => p.slug), ['christmas-1900', 'laxey-wheel'], 'all posts, future ones too, newest first');
    assert.ok(index.posts.every(p => !('body' in p)));
    const post = JSON.parse(await readFile(join(out, 'blog/posts/laxey-wheel.json'), 'utf8'));
    assert.equal(post.slug, 'laxey-wheel');
    assert.match(post.body, /\[turned\]\(\/read\//);
    assert.deepEqual(await readFile(join(out, 'blog/images/laxey-wheel/wheel.jpg')), JPEG);
    await writeFile(join(dir, 'posts/bad.md'), 'no front matter');
    await assert.rejects(build(dir, join(out, 'second')), /Content is not valid:\nposts\/bad.md: front matter/);
    await assert.rejects(readFile(join(out, 'second/blog/index.json')));
  } finally { await rm(dir, {recursive: true, force: true}); await rm(out, {recursive: true, force: true}); }
});

test('publishing fails cleanly, before any upload, when a secret is missing or malformed', () => {
  const run = env => spawnSync('bash', ['scripts/publish.sh'], {cwd: root, encoding: 'utf8',
    env: {PATH: process.env.PATH, ...env, ...(process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {})}});
  const none = run({});
  assert.equal(none.status, 1);
  assert.match(none.stdout, /::error::Missing repository Actions secret\(s\): R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY CF_ACCOUNT_ID\. Nothing was published\./);
  const one = run({R2_ACCESS_KEY_ID: 'k', CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef'});
  assert.match(one.stdout, /secret\(s\): R2_SECRET_ACCESS_KEY\. /);
  const bad = run({R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 'very-secret-value', CF_ACCOUNT_ID: 'not-an-id'});
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /CF_ACCOUNT_ID is not a 32-character Cloudflare account ID/);
  for (const r of [none, one, bad]) assert.doesNotMatch(r.stdout + r.stderr, /very-secret-value|Built |Published/);
});

test('publishing order: images and posts, then the index, then deletion, only under blog/ of the one bucket', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'content-aws-'));
  const log = join(bin, 'calls.txt');
  await writeFile(join(bin, 'aws'), '#!/usr/bin/env bash\nprintf "%s\n" "$*" >> "$AWS_LOG"\n', {mode: 0o755});
  try {
    const r = spawnSync('bash', ['scripts/publish.sh'], {cwd: root, encoding: 'utf8', env: {PATH: process.env.PATH,
      ...(process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {}),
      AWS_CLI: join(bin, 'aws').replaceAll('\\', '/'), AWS_LOG: log.replaceAll('\\', '/'),
      R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 'very-secret-value', CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef'}});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /very-secret-value/);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => line.replace(/\/tmp\/tmp\.[A-Za-z0-9]+/g, 'OUT'));
    const endpoint = 's3 --endpoint-url https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com --only-show-errors ';
    const steps = calls.map(c => { assert.ok(c.startsWith(endpoint), c); return c.slice(endpoint.length); });
    // This repository has no images yet, so the image sync is skipped.
    assert.equal(steps.length, 3, steps.join('\n'));
    assert.match(steps[0], /^sync OUT\/blog\/posts s3:\/\/manxpapers-content\/blog\/posts --content-type application\/json$/);
    assert.match(steps[1], /^cp OUT\/blog\/index\.json s3:\/\/manxpapers-content\/blog\/index\.json --content-type application\/json$/);
    assert.match(steps[2], /^sync OUT\/blog s3:\/\/manxpapers-content\/blog --delete$/);
    assert.match(r.stdout, /Published 0 post\(s\) and 0 image\(s\) to manxpapers-content\/blog\//);
  } finally { await rm(bin, {recursive: true, force: true}); }
});

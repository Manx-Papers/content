import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {parsePost} from '../scripts/frontmatter.mjs';
import {checkPost, checkClippings, validate, build} from '../scripts/content.mjs';

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
  assert.match(none.stdout, /::error::Missing blog-publish Environment secret\(s\): R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY CF_ACCOUNT_ID\. Nothing was published\./);
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
  const sha = 'a'.repeat(40);
  const run = env => spawnSync('bash', ['scripts/publish.sh'], {cwd: root, encoding: 'utf8', env: {PATH: process.env.PATH,
    ...(process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {}),
    AWS_CLI: join(bin, 'aws').replaceAll('\\', '/'), AWS_LOG: log.replaceAll('\\', '/'),
    R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 'very-secret-value', CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', ...env}});
  const calls = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean); } catch { return []; } };
  try {
    const r = run({CONTENT_PUBLISH_TEST: '1', MAIN_TIP: sha, GITHUB_SHA: sha});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /very-secret-value/);
    const endpoint = 's3 --endpoint-url https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com --only-show-errors ';
    const steps = (await calls()).map(line => line.replace(/\/tmp\/tmp\.[A-Za-z0-9]+/g, 'OUT')).map(c => { assert.ok(c.startsWith(endpoint), c); return c.slice(endpoint.length); });
    // This repository has no images yet, so the image sync is skipped.
    assert.equal(steps.length, 3, steps.join('\n'));
    assert.match(steps[0], /^sync OUT\/blog\/posts s3:\/\/manxpapers-content\/blog\/posts --content-type application\/json$/);
    assert.match(steps[1], /^cp OUT\/blog\/index\.json s3:\/\/manxpapers-content\/blog\/index\.json --content-type application\/json$/);
    assert.match(steps[2], /^sync OUT\/blog\/ s3:\/\/manxpapers-content\/blog\/ --delete$/);
    const postCount = (await readdir(join(root, 'posts'))).filter(f => f.endsWith('.md')).length;
    assert.match(r.stdout, new RegExp('Published ' + postCount + ' post\\(s\\) and 0 image\\(s\\) to manxpapers-content/blog/'));
    await rm(log, {force: true});

    // A run whose commit is no longer main's tip (re-run of an old run, or overtaken) publishes nothing.
    const old = run({CONTENT_PUBLISH_TEST: '1', MAIN_TIP: 'b'.repeat(40), GITHUB_SHA: sha});
    assert.equal(old.status, 0, old.stdout + old.stderr);
    assert.match(old.stdout, /::warning::Nothing was published: this run's commit a{40} is no longer the tip of main \(b{40}\)\..*run this workflow manually on main/);
    assert.deepEqual(await calls(), []);
    // A tip that is not a commit id is an error, never a quiet skip.
    const garbled = run({CONTENT_PUBLISH_TEST: '1', MAIN_TIP: '<html>', GITHUB_SHA: sha});
    assert.equal(garbled.status, 1);
    assert.match(garbled.stdout, /::error::The current tip of main could not be read as a commit\. Nothing was published\./);
    assert.deepEqual(await calls(), []);

    // The AWS_CLI override is the test harness only: without CONTENT_PUBLISH_TEST the aws on PATH runs.
    // (Inside Actions it is never honoured either; that path also reads main's tip over the network.)
    const shadow = join(bin, 'path');
    await mkdir(shadow);
    await writeFile(join(shadow, 'aws'), '#!/usr/bin/env bash\nprintf "%s\n" "$*" >> "$AWS_LOG.path"\n', {mode: 0o755});
    const plain = run({PATH: shadow.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase()) + ':' + process.env.PATH});
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    assert.deepEqual(await calls(), [], 'AWS_CLI ignored outside the harness');
    assert.equal((await readFile(log + '.path', 'utf8')).trim().split('\n').length, 3, 'the aws on PATH ran instead');
  } finally { await rm(bin, {recursive: true, force: true}); }
});

test('review fixes: rendered figures and archive links, reserved keys, # in bare values, escaped annotations', async () => {
  // Figures are taken from the rendered HTML: own-path form and figures inside quotes are checked too.
  const body = '[a](/read/IME/IME-1854-09-29/3)\n\n![One](/blog/images/laxey-wheel/one.jpg)\n\n> ![Two](two.png)';
  assert.deepEqual(checkPost('laxey-wheel', good('', body)).figures, ['one.jpg', 'two.png']);
  const dir = await repo({'posts/laxey-wheel.md': good('', body), 'images/laxey-wheel/two.png': PNG});
  try {
    assert.deepEqual((await validate(dir)).errors, ['posts/laxey-wheel.md: image one.jpg is not in images/laxey-wheel/']);
  } finally { await rm(dir, {recursive: true, force: true}); }

  // Archive page images are refused by the Worker's renderer, which points to section: clippings (web#183).
  assert.deepEqual(checkPost('laxey-wheel', good('', '[a](/read/IME/IME-1854-09-29/3)\n\n![Page 3](/media/page/IME/IME-1854-09-29/0003.jpg)')).errors,
    ['text: archive page images are not allowed in posts: show a section as a clipping with ![headline](section:<section ID>): /media/page/IME/IME-1854-09-29/0003.jpg']);

  // The archive link must be a rendered link to a path the Worker accepts as a source.
  for (const [text, ok] of [
    ['See `[a](/read/IME/IME-1854-09-29/3)` in code.', false],
    ['See [a](/read/zzz).', false],
    ['See [a](/read/IME/IME-1854-09-29/3).', true],
    ['See [a](/search?view=IME%2FIME-1854-09-29%2F0003%2Frecord%2F12).', true],
    ['> Quoted [a](/read/IME/IME-1854-09-29/3).', true],
  ]) assert.equal(checkPost('laxey-wheel', good('', text)).errors.some(e => /link at least one claim/.test(e)), !ok, text);

  // Reserved keys are refused, never silently dropped or used as a prototype.
  for (const key of ['__proto__', 'constructor', 'prototype'])
    assert.throws(() => parsePost('---\n' + key + ': x\n---\n'), new RegExp(key + ' is not allowed'), key);
  assert.throws(() => parsePost('---\nsources:\n  - __proto__: x\n---\n'), /__proto__ is not allowed/);
  assert.throws(() => parsePost('---\nsources:\n  - url: /read/A/B/1\n    __proto__: x\n---\n'), /__proto__ is not allowed/);

  // " #" in bare text must be quoted; a comment after a single token (as in the template) is fine.
  assert.throws(() => parsePost('---\ntitle: Issue #5 report\n---\n'), /quote this value, it contains " #"/);
  assert.throws(() => parsePost('---\ntitle: Issue # 5\n---\n'), /quote this value/);
  assert.deepEqual(parsePost('---\ntitle: "Issue #5 report"\ndate: 2026-12-01   # listed from\nimage: wheel.jpg # share\nok: true # yes\n---\n').data,
    {title: 'Issue #5 report', date: '2026-12-01', image: 'wheel.jpg', ok: true});
  assert.equal(parsePost('---\ntitle: C#-style\n---\n').data.title, 'C#-style');

  // Annotations escape %, CR and LF, so a file name cannot start a second workflow command line.
  const source = await readFile(join(root, 'scripts/validate.mjs'), 'utf8');
  assert.doesNotMatch(source, /console\.log\('::error::' \+ (?!String\(text\))/);
  const annotate = new Function('console', source.match(/const annotate = ([^;]+);/)[1].replace(/^/, 'return ') + ';');
  const lines = [];annotate({log: line => lines.push(line)})('posts/a\r\n::warning::x%.md');
  assert.deepEqual(lines, ['::error::posts/a%0D%0A::warning::x%25.md']);
});

test('a source without a label is a warning, not an error; the template has none', async () => {
  const template = checkPost('laxey-wheel', await readFile(join(root, 'templates/post.md'), 'utf8'));
  assert.deepEqual(template.warnings, []);
  assert.ok(template.post.sources.every(source => typeof source === 'object' && source.label), 'every template source is {url, label}');
  const bare = checkPost('laxey-wheel', good());
  assert.deepEqual(bare.errors, []);
  assert.ok(bare.post, 'still publishable');
  assert.deepEqual(bare.warnings, ['source /read/IME/IME-1854-09-29/3 has no label; add label: "Paper, date: headline"']);
  const labelled = checkPost('laxey-wheel', good().replace('  - /read/IME/IME-1854-09-29/3\n', '  - url: /read/IME/IME-1854-09-29/3\n    label: "Isle of Man Examiner, 29 September 1854: front page"\n'));
  assert.deepEqual([labelled.errors, labelled.warnings], [[], []]);
  const dir = await repo({'posts/laxey-wheel.md': good()});
  try {
    const result = await validate(dir);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, ['posts/laxey-wheel.md: ' + bare.warnings[0]]);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('web#183: a clipping is one archive section; the check refuses what the Worker would leave out', () => {
  const S = 'IMT/IMT-1954-04-24/0006/block/';
  const ok = checkPost('laxey-wheel', good('', [
    '[a](/read/IME/IME-1854-09-29/3)', '',
    "![Clubman's T.T. rider weds](section:" + S + 'R00100-B000?highlight=rider+weds "A T.T. rider marries.")', '',
    '![The couple](section:' + S + 'R00101-B000)', '::: description', 'The bride and groom outside the church.', ':::', '',
    '![The wedding](section:' + S + 'R00100-B001)', '::: text', 'Gwilym Owen was *married* at Kirk Braddan.', ':::', '',
    '![The service](section:' + S + 'R00245-B000?highlight="Rev.+B.+Kelly")',
  ].join('\n')));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.figures, [], 'nothing to find in images/');
  assert.deepEqual(ok.clippings.map(c => [c.id, c.highlight]), [
    [S + 'R00100-B000', 'rider weds'], [S + 'R00101-B000', null], [S + 'R00100-B001', null], [S + 'R00245-B000', '"Rev. B. Kelly"']]);
  // A pasted copy-link address after section: is stored as the section ID.
  for (const pasted of ['https://beta.manxpapers.com/sections/' + S + 'R00100-B000', 'https://manxpapers.com/sections/' + S + 'R00100-B000', '/sections/' + S + 'R00100-B000']) {
    const result = checkPost('laxey-wheel', good('', '[a](/read/IME/IME-1854-09-29/3)\n\n![Rider weds](section:' + pasted + '?highlight=rider)'));
    assert.deepEqual(result.errors, [], pasted);
    assert.match(result.post.body, new RegExp('\\]\\(section:' + S + 'R00100-B000\\?highlight=rider\\)\\n?$'), pasted);
  }
  for (const [line, error] of [
    ['![Halt](article:IMT/IMT-1938-10-08/0004/record/231)', /^text: not an archive section reference/],
    ['![Halt](section:https://beta.manxpapers.com/items/IMT/IMT-1938-10-08/0004/record/231)', /^text: not an archive section reference/],
    ['![Halt](section:IMT/IME-1954-04-24/0006/block/R00100-B000)', /^text: not an archive section reference/],
    ['![Halt](section:' + S + 'R00100-B000?highlight=<b>)', /^text: not an archive section reference/],
    ['![](section:' + S + 'R00100-B000)', /^text: clipping needs alt text/],
    ['> ![Halt](section:' + S + 'R00100-B000)', /^text: clippings cannot go inside a quote/],
    ['![Halt](section:' + S + 'R00100-B000)\n::: text\nnot closed', /^text: the ::: text block has no closing :::/],
    ['::: description\nStray.\n:::', /^text: a ::: description block must come straight after its section: clipping line/],
  ]) {
    const {errors} = checkPost('laxey-wheel', good('', '[a](/read/IME/IME-1854-09-29/3)\n\n' + line));
    assert.ok(errors.some(e => error.test(e)), line + ' → ' + JSON.stringify(errors));
  }
});

test('web#183: the check looks each clipping up in the archive and warns, never silently', async () => {
  const S = 'IMT/IMT-1954-04-24/0006/block/';
  const body = ['[a](/read/IME/IME-1854-09-29/3)', '',
    '![Rider weds](section:' + S + 'R00100-B000?highlight=rider+weds)', '',
    '![Again](section:' + S + 'R00100-B000?highlight=rider+weds)', '',
    '![Bridesmaids](section:' + S + 'R00246-B000?highlight=bridesmaid)', '',
    '![Elsewhere](section:' + S + 'R00100-B001?highlight=Braddan)', '',
    '![Photo](section:' + S + 'R00101-B000)', '',
    '![Missing](section:' + S + 'R09999-B000)', '',
    '![Busy](section:' + S + 'R00300-B000)', '',
    '![Offline](section:' + S + 'R00301-B000)'].join('\n');
  const asked = [];
  const json = (status, doc) => ({ok: status === 200, status, json: async () => doc});
  const section = (id, hits) => json(200, {section: {id: S + id, source_block_id: id}, hit_geometry: hits});
  const fetchSection = async (url, init) => {
    asked.push(url);
    assert.ok(init.signal instanceof AbortSignal, 'every lookup has a time limit');
    const [, path, query] = url.match(/\/api\/sections\/(.+?)(?:\?(.*))?$/);
    const id = path.slice(S.length);
    if (id === 'R00100-B000') return section(id, [{text: 'rider', block_id: id}, {text: 'weds', block_id: id}]);
    if (id === 'R00246-B000') return section(id, []);
    // Hits in another block of the same Item don't count: the clipping shows only its own block.
    if (id === 'R00100-B001') return section(id, [{text: 'Braddan', block_id: 'R00245-B000'}]);
    if (id === 'R00101-B000') { assert.equal(query, undefined); return section(id, []); }
    if (id === 'R09999-B000') return json(404, {detail: 'not found'});
    if (id === 'R00300-B000') return json(503, {detail: 'busy'});
    throw new Error('network down');
  };
  const dir = await repo({'posts/laxey-wheel.md': good('', body)});
  try {
    const result = await validate(dir, {fetchSection});
    assert.deepEqual(result.errors, []);
    const W = 'posts/laxey-wheel.md: clipping ' + S;
    assert.deepEqual(result.warnings.filter(w => !/has no label/.test(w)), [
      W + 'R00246-B000: highlight "bridesmaid" matches nothing in the text the archive read for this section, so nothing will be highlighted. Highlights match the recognised text (see "Read the text"), not the true spelling.',
      W + 'R00100-B001: highlight "Braddan" matches nothing in the text the archive read for this section, so nothing will be highlighted. Highlights match the recognised text (see "Read the text"), not the true spelling.',
      W + "R09999-B000: the archive has no such section; the site will say the clipping can't be shown",
      W + "R00300-B000: couldn't check it in the archive (status 503); check it on the preview",
      W + "R00301-B000: couldn't check it in the archive (network down); check it on the preview",
    ]);
    assert.equal(asked.length, 7, 'the same section and highlight are looked up once');
    assert.match(asked[0], /^https:\/\/[^/]+\/api\/sections\/IMT\/IMT-1954-04-24\/0006\/block\/R00100-B000\?q=rider\+weds$/);
    // The publish build doesn't look anything up.
    asked.length = 0;
    await build(dir, join(dir, 'out'), {fetchSection});
    assert.equal(asked.length, 0);
  } finally { await rm(dir, {recursive: true, force: true}); }
  assert.deepEqual(await checkClippings([], () => { throw new Error('not called'); }), []);
});

test('web#183: an archive that hangs gets warnings within the overall time limit, never a stuck job', async () => {
  const S = 'IMT/IMT-1954-04-24/0006/block/';
  const posts = {};
  for (const n of [1, 2, 3]) posts['posts/post-' + n + '.md'] = good('', '[a](/read/IME/IME-1854-09-29/3)\n\n![Clip](section:' + S + 'R0010' + n + '-B000)');
  const dir = await repo(posts);
  let asked = 0;
  // Never answers and ignores the abort signal, as a hung connection might.
  const fetchSection = () => { asked++; return new Promise(() => {}); };
  try {
    const started = Date.now();
    const result = await validate(dir, {fetchSection, archiveBudgetMs: 300});
    const took = Date.now() - started;
    assert.ok(took < 2000, 'finished in ' + took + ' ms');
    assert.deepEqual(result.errors, []);
    const clipping = result.warnings.filter(w => /clipping/.test(w));
    assert.equal(clipping.length, 3, JSON.stringify(clipping));
    assert.match(clipping[0], /^posts\/post-1\.md: clipping .*R00101-B000: couldn't check it in the archive \(no answer within 1 s\); check it on the preview$/);
    assert.match(clipping[1], /R00102-B000: couldn't check it in the archive \(the archive check ran out of time\)/);
    assert.match(clipping[2], /R00103-B000: couldn't check it in the archive \(the archive check ran out of time\)/);
    assert.equal(asked, 1, 'nothing is asked once the time is up');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('web#183: the blog-writer instructions show clippings the check accepts', async () => {
  const prompt = await readFile(join(root, 'BLOG-WRITER-PROMPT.md'), 'utf8');
  const examples = [...prompt.matchAll(/`(!\[[^\]`]+\]\(section:IMT\/[^`]+\))`/g)].map(m => m[1]);
  assert.equal(examples.length, 2, 'two worked examples');
  const {errors, clippings} = checkPost('laxey-wheel', good('', '[a](/read/IME/IME-1854-09-29/3)\n\n' + examples.join('\n\n')));
  assert.deepEqual(errors, []);
  assert.deepEqual(clippings.map(c => c.highlight), ['rider weds', '"Rev. B. Kelly"']);
  assert.doesNotMatch(prompt, /\]\(article:/, 'no whole-Article clippings');
});

// Review of content#1 at b8c7bdf: pasted copy-link addresses, unlabelled {url} sources and tags.
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkPost, sitePath, bodyPaths} from '../scripts/content.mjs';

const ITEM = 'IME/IME-1946-07-05/0001/record/172';
const VIEW = '/search?view=IME%2FIME-1946-07-05%2F0001%2Frecord%2F172', PAGE = '/items/' + ITEM;
const SECTION = 'IMT/IMT-1954-04-24/0006/block/R00100-B000';
const LABEL = 'Isle of Man Examiner, 5 July 1946: Do We Still Offer a Magic Holiday Isle?';
const postWith = (sources, body = 'The [Examiner asked](' + VIEW + ').', extra = '') =>
  '---\ntitle: "The magic holiday isle"\ndate: 2026-11-01\nsummary: "What the paper asked."\n' + extra + 'sources:\n' + sources + '---\n' + body + '\n';

test('copy-link addresses (Beta, live or www; Article page or View Article) are stored as the Article page (web#189)', () => {
  for (const pasted of ['https://beta.manxpapers.com/items/' + ITEM, 'https://manxpapers.com/items/' + ITEM, 'https://www.manxpapers.com/items/' + ITEM,
    PAGE, '/sections/' + ITEM, 'https://beta.manxpapers.com' + VIEW, VIEW, '/search?view=' + ITEM])
    assert.equal(sitePath(pasted), PAGE, pasted);
  // A section's address stays a section page, which opens its Article at that section.
  for (const pasted of ['https://beta.manxpapers.com/sections/' + SECTION, '/items/' + SECTION, '/search?view=' + encodeURIComponent(SECTION)])
    assert.equal(sitePath(pasted), '/sections/' + SECTION, pasted);
  assert.equal(sitePath('https://beta.manxpapers.com/read/IME/IME-1946-07-05/1'), '/read/IME/IME-1946-07-05/1');
  // Other sites, http, look-alike hosts and odd identifiers are left alone (and then refused as sources).
  for (const other of ['https://example.com/items/' + ITEM, 'http://beta.manxpapers.com/items/' + ITEM, 'https://manxpapers.com.evil.example/items/x',
    'https://evilmanxpapers.com/items/x', '/items/a b', '/items/a?x=1', '/search?view=a%2F%2Fb', '/search?view=a%3Ab', '/search?view=%E0',
    '/search?q=x&view=' + ITEM])
    assert.equal(sitePath(other), other, other);
});

test('a post whose sources and links are pasted copy-link addresses passes, stored with site paths', () => {
  const pasted = 'https://beta.manxpapers.com/items/' + ITEM;
  const {post, errors, warnings} = checkPost('magic-holiday', postWith(
    '  - url: ' + pasted + '\n    label: "' + LABEL + '"\n  - url: https://manxpapers.com/read/IME/IME-1946-07-05/1\n    label: "Isle of Man Examiner, 5 July 1946: front page"\n',
    'The [Examiner asked](' + pasted + ') on [the front page](https://www.manxpapers.com/read/IME/IME-1946-07-05/1). ![A view](https://beta.manxpapers.com/items/' + ITEM + ')'));
  // The image is refused as before (archive images aren't allowed yet); the links themselves are fine.
  assert.deepEqual(errors.filter(e => !e.startsWith('text: image')), []);
  assert.deepEqual(warnings, []);
  const ok = checkPost('magic-holiday', postWith('  - url: ' + pasted + '\n    label: "' + LABEL + '"\n', 'The [Examiner asked](' + pasted + ').'));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.post.sources, [{url: PAGE, label: LABEL}]);
  assert.equal(ok.post.body, 'The [Examiner asked](' + PAGE + ').\n');
  // A link only to another site still doesn't count as an archive link.
  const external = checkPost('magic-holiday', postWith('  - url: ' + VIEW + '\n    label: "' + LABEL + '"\n', 'See [elsewhere](https://example.com/items/' + ITEM + ').'));
  assert.ok(external.errors.some(e => e.includes('link at least one claim to the archive')), external.errors.join('; '));
  assert.ok(checkPost('magic-holiday', postWith('  - url: https://example.com/items/' + ITEM + '\n    label: "x"\n')).errors.some(e => /front matter: source/.test(e)));
});

test('text in a link label or code is not rewritten; only link targets are', () => {
  assert.equal(bodyPaths('`https://beta.manxpapers.com/items/x` and [https://beta.manxpapers.com/items/x](/read/IME/IME-1946-07-05/1)'),
    '`https://beta.manxpapers.com/items/x` and [https://beta.manxpapers.com/items/x](/read/IME/IME-1946-07-05/1)');
  assert.equal(bodyPaths('[a](https://beta.manxpapers.com/items/x "title")'), '[a](/items/x "title")');
  // An older View Article link in the text is stored as the Article page too.
  assert.equal(bodyPaths('[a](' + VIEW + ')'), '[a](' + PAGE + ')');
});

test('every source without a label warns, string or {url}', () => {
  const {errors, warnings} = checkPost('magic-holiday', postWith('  - ' + VIEW + '\n  - url: /read/IME/IME-1946-07-05/1\n  - url: ' + VIEW + '\n    label: "' + LABEL + '"\n'));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, [
    'source ' + PAGE + ' has no label; add label: "Paper, date: headline"',
    'source /read/IME/IME-1946-07-05/1 has no label; add label: "Paper, date: headline"',
  ]);
});

test('tags the site can show pass; others fail with the rule, as the site refuses them', () => {
  const tags = list => checkPost('magic-holiday', postWith('  - url: ' + VIEW + '\n    label: "' + LABEL + '"\n', undefined, 'tags: ' + list + '\n'));
  assert.deepEqual(tags('[tourism, "St. John\'s", "Laxey & Lonan", 1946]').errors, []);
  for (const bad of ['"1850s?"', '"Laxey  Wheel"', '"a/b"'])
    assert.ok(tags('[' + bad + ']').errors.some(e => /^front matter: tag .*: use words of letters, digits, hyphens, apostrophes, full stops or &/.test(e)), bad);
});

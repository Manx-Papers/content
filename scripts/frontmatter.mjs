// A strict front-matter reader for blog posts: the small YAML subset the post template uses, with
// no dependencies. Anything outside that subset is an error rather than a guess.
//
//   key: value            bare text (a trailing " # comment" is dropped), true/false → boolean
//   key: "text"           double quotes (\" and \\ escapes) or 'text' ('' for a quote)
//   key: [a, "b c"]       inline list of scalars
//   key:                  block list of scalars or of one-level maps:
//     - /read/...           - url: /read/...
//                             label: "..."
// Every value other than true/false stays a string (dates included), as the schema expects.

const KEY = /^([a-z_][a-z0-9_]*):(?:\s+(.*))?$/;

function scalar(raw, where) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\["\\])*)"\s*(?:#.*)?$/.exec(text);
    if (!m) throw new Error(where + ': unterminated or invalid double-quoted text');
    return m[1].replace(/\\(["\\])/g, '$1');
  }
  if (text.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(text);
    if (!m) throw new Error(where + ': unterminated or invalid single-quoted text');
    return m[1].replaceAll("''", "'");
  }
  const bare = text.replace(/\s+#.*$/, '');
  if (/^[[{&*!|>%@`]/.test(bare)) throw new Error(where + ': quote this value');
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  if (bare === '' || bare === '~' || bare === 'null') throw new Error(where + ': empty value');
  return bare;
}

function inlineList(raw, where) {
  const m = /^\[(.*)\]\s*(?:#.*)?$/.exec(raw.trim());
  if (!m) throw new Error(where + ': invalid list');
  if (!m[1].trim()) return [];
  const items = [];
  for (const part of m[1].matchAll(/\s*("(?:[^"\\]|\\["\\])*"|'(?:[^']|'')*'|[^,"']+)\s*(?:,|$)/g)) items.push(scalar(part[1], where));
  return items;
}

// Returns {data, body}. Throws on anything outside the subset.
export function parsePost(source) {
  const text = String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('front matter must start the file between --- lines');
  const lines = m[1].split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const where = 'line ' + (i + 2);
    if (/^\s/.test(line)) throw new Error(where + ': unexpected indentation');
    const key = KEY.exec(line);
    if (!key) throw new Error(where + ': expected "key: value"');
    const [, name, rest] = key;
    if (Object.hasOwn(data, name)) throw new Error(where + ': duplicate key ' + name);
    if (rest !== undefined && rest.replace(/(?:^|\s+)#.*$/, '').trim() !== '') {
      data[name] = rest.trim().startsWith('[') ? inlineList(rest, where) : scalar(rest, where);
      continue;
    }
    // Block list.
    const list = [];
    while (i + 1 < lines.length && (/^\s+-(?:\s|$)/.test(lines[i + 1]) || /^\s+[a-z_]/.test(lines[i + 1]) || !lines[i + 1].trim() || /^\s*#/.test(lines[i + 1]))) {
      const next = lines[++i], at = 'line ' + (i + 2);
      if (!next.trim() || /^\s*#/.test(next)) continue;
      const item = /^(\s+)-\s+(.*)$/.exec(next);
      if (item) {
        const inner = KEY.exec(item[2]);
        if (inner && !/^["']/.test(item[2])) {
          const entry = {[inner[1]]: scalar(inner[2] ?? '', at)};
          const indent = item[1].length + 2;
          while (i + 1 < lines.length && new RegExp('^ {' + indent + '}[a-z_]').test(lines[i + 1])) {
            const field = KEY.exec(lines[++i].slice(indent));
            if (!field) throw new Error('line ' + (i + 2) + ': expected "key: value"');
            if (Object.hasOwn(entry, field[1])) throw new Error('line ' + (i + 2) + ': duplicate key ' + field[1]);
            entry[field[1]] = scalar(field[2] ?? '', 'line ' + (i + 2));
          }
          list.push(entry);
        } else list.push(scalar(item[2], at));
      } else throw new Error(at + ': expected a "- " list item');
    }
    if (!list.length) throw new Error(where + ': ' + name + ' has no value');
    data[name] = list;
  }
  return {data, body: m[2].replace(/^\n+/, '')};
}

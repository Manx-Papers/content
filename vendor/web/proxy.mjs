// Control #165 step 3: same-origin API and Media for the website.
// The browser calls /api/*, /iiif/* and /media/* on the site's own host; this Worker forwards
// them only through the service bindings API and MEDIA, using the canonical upstream URLs, as the
// MCP, API and Media Workers already do. It never fetches the public API and Media hostnames, so
// the website keeps working while they sit behind Cloudflare Access. There is no URL input:
// destinations are fixed and paths are a bounded grammar of what the site actually requests.
// Control #240 D1: the canonical API and Media origins are the deployment's Worker variables
// API_ORIGIN and MEDIA_ORIGIN (config/environments.json), never constants here.
import {securityHeaders as defaultSecurityHeaders} from './security.mjs';

const ORIGIN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// The deployment's canonical API and Media origins. Throws if either is missing or malformed:
// the Worker fails closed rather than guess another deployment's origins.
export function origins(env) {
  const api = env?.API_ORIGIN, media = env?.MEDIA_ORIGIN;
  if (typeof api !== 'string' || !ORIGIN.test(api)) throw new Error('Worker variable API_ORIGIN is missing or malformed');
  if (typeof media !== 'string' || !ORIGIN.test(media)) throw new Error('Worker variable MEDIA_ORIGIN is missing or malformed');
  return {api, media};
}
// Every API read the site, Reader and UV make (site/app.js, site/reader.js, site/state.js).
const API_PATH = /^\/api\/(?:catalogue|query|search|on-this-day|issues(?:\/pagination)?|calendar(?:\/year)?|(?:items|sections|pages|reader|issues)\/[A-Za-z0-9_:/.-]+)$/;
const IIIF_PATH = /^\/iiif\/[A-Z][A-Z0-9]{1,11}\/[A-Za-z0-9_-]+\/(?:manifest|canvas\/\d{1,6})$/;
// Media's own public grammar (workers/media in Search): thumbnails, originals and previews.
// Title membership and availability remain Media's decision.
const ISSUE = '([A-Z][A-Z0-9]{1,11})\\/([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*)';
const MEDIA_PATHS = [
  new RegExp('^\\/media\\/issue-thumbnail\\/' + ISSUE + '\\.jpg$'),
  new RegExp('^\\/media\\/page\\/' + ISSUE + '\\/(\\d{4})\\.(?:jpg|png)$'),
  new RegExp('^\\/media\\/search-page-preview\\/' + ISSUE + '\\/(\\d{4})\\.webp$'),
];
export function isMediaPath(path) {
  for (const pattern of MEDIA_PATHS) {
    const match = pattern.exec(path);
    if (!match) continue;
    const [, title, issue, page] = match;
    return issue.length <= 64 && (issue.startsWith(title + '-') || issue.startsWith(title + '_')) && page !== '0000';
  }
  return false;
}
export const METHODS = ['GET', 'HEAD'];
// Only content negotiation, ranges and validators. Cookie (including CF_Authorization),
// Authorization, Cf-Access-* assertions/service-token headers and Origin never reach a binding.
export const REQUEST_HEADERS = ['accept', 'range', 'if-range', 'if-none-match', 'if-modified-since'];
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-range', 'accept-ranges',
  'etag', 'last-modified', 'retry-after', 'content-disposition', 'x-manx-papers-derivative'];
// Bodies served from this origin are data, never markup or script.
const API_TYPES = ['application/json', 'application/ld+json', 'text/plain'];
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'text/plain', 'application/json'];

export function isProxyPath(pathname) {
  return /^\/(?:api|iiif|media)(?:\/|$)/.test(pathname);
}

// Returns {binding, url} for a supported request, or null. `upstream` is origins(env).
export function proxyTarget(url, upstream) {
  const path = url.pathname;
  if (url.href.length > 8192 || /%|\\|\/\/|\/\.\.?(?:\/|$)/.test(path)) return null;
  if (API_PATH.test(path) || IIIF_PATH.test(path)) return {binding: 'API', url: upstream.api + path + url.search};
  // Media has no query parameters; refuse rather than drop them.
  if (isMediaPath(path) && !url.search)
    return {binding: 'MEDIA', url: upstream.media + path.slice('/media'.length)};
  return null;
}

// Browser caching stays as upstream intends, but private: these responses are only reachable
// through the Access-protected website, so no shared cache may store them.
export function privateCacheControl(value) {
  const kept = (value || '').split(',').map(part => part.trim()).filter(Boolean)
    .filter(part => !/^(?:public|private|s-maxage=.*|proxy-revalidate)$/i.test(part));
  return kept.length ? ['private', ...kept].join(', ') : 'private, no-cache';
}

function refusedWith(status, securityHeaders = defaultSecurityHeaders, extra = {}) {
  return new Response(null, {status, headers: {...securityHeaders, ...extra, 'Cache-Control': 'private, no-store'}});
}

export async function proxy(request, env, securityHeaders = defaultSecurityHeaders) {
  const refused = (status, extra) => refusedWith(status, securityHeaders, extra);
  if (!METHODS.includes(request.method)) return refused(405);
  const target = proxyTarget(new URL(request.url), origins(env));
  if (!target) return refused(404);
  const binding = env?.[target.binding];
  if (!binding || typeof binding.fetch !== 'function') return refused(503);
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  let upstream;
  try {
    upstream = await binding.fetch(new Request(target.url, {method: request.method, headers, redirect: 'manual'}));
  } catch { return refused(502); }
  // A redirect would leave the bound Worker (for example to an Access login): never follow or relay it.
  if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
    await upstream.body?.cancel(); return refused(502);
  }
  const type = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const allowed = target.binding === 'API' ? API_TYPES : MEDIA_TYPES;
  if (upstream.body && request.method !== 'HEAD' && ![204, 304].includes(upstream.status) && !allowed.includes(type)) {
    await upstream.body.cancel();
    // An upstream error page (for example a platform 429/503 in HTML) keeps its status and
    // Retry-After, so the site's retry still works, but its body is never relayed.
    if (upstream.status >= 400 && upstream.status < 600) {
      const retry = upstream.headers.get('retry-after');
      return refused(upstream.status, retry ? {'Retry-After': retry} : {});
    }
    return refused(502);
  }
  const output = new Headers(securityHeaders);
  for (const name of RESPONSE_HEADERS) if (upstream.headers.has(name)) output.set(name, upstream.headers.get(name));
  output.set('Cache-Control', privateCacheControl(upstream.headers.get('cache-control')));
  if (request.method === 'HEAD') { await upstream.body?.cancel(); return new Response(null, {status: upstream.status, headers: output}); }
  return new Response(upstream.body, {status: upstream.status, headers: output});
}

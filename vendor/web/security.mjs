// One policy for dynamic responses and the generated Static Assets _headers file.
// GA4 (Web #113): www.googletagmanager.com serves gtag.js; *.google-analytics.com and
// *.analytics.google.com receive measurement hits (regional collectors vary). These
// origins are only reachable after a visitor accepts analytics, and then only from the
// isolated /assets/analytics-frame.html; site/consent.js requests nothing before then. gtag.js is generated dynamically per
// measurement ID and changes without notice, so it cannot carry SRI; it is pinned to
// its single origin instead.
//
// Control #165: the Beta website reaches the API and Media same-origin (/api, /iiif, /media through
// the Worker's service bindings), so its policy no longer admits api-beta or media-beta.
// directOriginSecurityHeaders keeps the previous policy for a non-Beta build (prepare.mjs and
// cf build --mode other than beta), whose browser code still calls those hostnames directly. The
// Worker and the generated _headers file both choose through securityHeadersFor, so a build serves
// one policy everywhere.
const csp = (img, connect) => "default-src 'self'; script-src 'self' 'unsafe-eval' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self'"+img+" data: blob: https://*.google-analytics.com; connect-src 'self'"+connect+" https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com; font-src 'self' data:; object-src 'none'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";
const common = {
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};
export const securityHeaders = {...common, 'Content-Security-Policy': csp('', '')};
export const directOriginSecurityHeaders = {...common,
  'Content-Security-Policy': csp(' https://media-beta.manxpapers.com', ' https://api-beta.manxpapers.com https://media-beta.manxpapers.com')};

// Beta (the default and the only deployable mode) is same-origin; every other mode is direct-origin.
export const isSameOriginMode = mode => (mode ?? 'beta') === 'beta';
export const securityHeadersFor = mode => isSameOriginMode(mode) ? securityHeaders : directOriginSecurityHeaders;

export function response(body, init = {}, headers = securityHeaders) {
  return new Response(body, {...init, headers: {...headers, 'Cache-Control': 'no-cache', ...init.headers}});
}

// One policy for dynamic responses and the generated Static Assets _headers file.
// GA4 (Web #113): www.googletagmanager.com serves gtag.js; *.google-analytics.com and
// *.analytics.google.com receive measurement hits (regional collectors vary). These
// origins are only reachable after a visitor accepts analytics, and then only from the
// isolated /assets/analytics-frame.html; site/consent.js requests nothing before then. gtag.js is generated dynamically per
// measurement ID and changes without notice, so it cannot carry SRI; it is pinned to
// its single origin instead.
//
// Control #165: the website reaches the API and Media same-origin (/api, /iiif, /media through the
// Worker's service bindings), so the policy admits no API or Media host. Control #240 D1: this is
// the only policy; it does not depend on the deployment.
const csp = "default-src 'self'; script-src 'self' 'unsafe-eval' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.google-analytics.com; connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com; font-src 'self' data:; object-src 'none'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";
const common = {
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};
export const securityHeaders = {...common, 'Content-Security-Policy': csp};

export function response(body, init = {}, headers = securityHeaders) {
  return new Response(body, {...init, headers: {...headers, 'Cache-Control': 'no-cache', ...init.headers}});
}

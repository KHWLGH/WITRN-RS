// Injected first by bench/ui-server.mjs so it registers before any app script runs.
//
// A CSP-blocked subresource is the worst kind of frontend failure: `img-src` denying a CSS
// `mask` image produces a blank icon, no failed network request in the devtools Network panel
// that anyone reads as broken, and no exception. The only reliable signal is the
// securitypolicyviolation event, and it has to be listened for before the browser gets to the
// blocked load — hence a served file, not an inline snippet (inline is what the shipped
// `script-src 'self'` forbids).
window.__CSP_VIOLATIONS = [];
document.addEventListener(
  'securitypolicyviolation',
  (e) => {
    window.__CSP_VIOLATIONS.push({
      blockedURI: String(e.blockedURI ?? '').slice(0, 160),
      directive: e.violatedDirective,
      kind: e.effectiveDirective,
      disposition: e.disposition,
    });
  },
  true,
);

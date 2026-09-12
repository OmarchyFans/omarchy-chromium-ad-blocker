// Global Privacy Control, page side. Registered into the page's own world only
// while opt-in 2 is on; the Sec-GPC request header is sent by the "gpc" rules.
// This is the browser saying "do not sell or share my data" — a legal opt-out
// that consent platforms such as OneTrust record — not a faked agreement.
(() => {
  try {
    if (navigator.globalPrivacyControl === true) return;
    Object.defineProperty(Navigator.prototype, "globalPrivacyControl", {
      get: () => true,
      configurable: true,
      enumerable: true,
    });
  } catch { /* never break the page */ }
})();

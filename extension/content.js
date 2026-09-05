// Omarchy Ad Blocker — content script.
//
// Three layers, cheapest first. Nothing waits on the layer behind it:
//
//   1. Static CSS, plus the rules already learned for this site, injected at
//      document_start so blocked elements never paint.
//   2. Synchronous DOM heuristics for overlays, modals and scroll locks. This is
//      what catches cookie walls and newsletter popups with no latency and no
//      network call.
//   3. The AI pass — only the elements the first two layers were unsure about
//      are described to the model, and both its yes and its no are cached, so a
//      site is classified once rather than once per page load.

(() => {
  const HOST = location.hostname;
  const STYLE_ID = "omarchy-adblock-style";
  const HIDE = "display:none!important;visibility:hidden!important;" +
               "opacity:0!important;pointer-events:none!important;";

  let settings = { enabled: true, ai: true, allowlist: [] };
  let aiPassDone = false;

  const hiddenSelectors = new Set();  // everything currently in our stylesheet
  const remoteSelectors = new Set();  // the subset that came from cache or the model
  const alreadyAsked = new Set();     // candidates the model has already ruled on
  const pendingCandidates = new Set();

  // ---------------------------------------------------------------- utilities

  const styleEl = () => {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  };

  const rebuildStyle = () => {
    styleEl().textContent =
      [...hiddenSelectors].map((s) => `${s}{${HIDE}}`).join("\n");
  };

  // Selectors arrive from a cache file and from the model, so they are never
  // trusted as syntax. A malformed one would poison the whole stylesheet rule
  // that follows it, so each is validated on its own before it is written out.
  const validSelector = (sel) => {
    if (typeof sel !== "string" || !sel || sel.length > 300) return false;
    if (/[{}<>]|@import|javascript:/i.test(sel)) return false;
    try { document.querySelector(sel); return true; } catch { return false; }
  };

  const isProtected = (el) => {
    if (!el || el === document.body || el === document.documentElement) return true;
    for (const sel of OMARCHY_PROTECTED) {
      try { if (el.matches(sel)) return true; } catch { /* selector list is ours */ }
    }
    // Never hide something wrapping a login or payment field.
    if (el.querySelector('input[type="password"], input[autocomplete*="cc-"]')) return true;
    return false;
  };

  const report = (n) => {
    if (n > 0) {
      chrome.runtime.sendMessage({ type: "blocked", count: n },
        () => void chrome.runtime.lastError);
    }
  };

  // Only selectors that actually match something here are counted, so the badge
  // reflects what was removed on this page rather than the size of the rule set.
  const applySelectors = (selectors, remote) => {
    const fresh = selectors.filter((s) => validSelector(s) && !hiddenSelectors.has(s));
    if (!fresh.length) return 0;
    fresh.forEach((s) => {
      hiddenSelectors.add(s);
      if (remote) remoteSelectors.add(s);
    });
    rebuildStyle();
    let matched = 0;
    for (const s of fresh) {
      try { matched += document.querySelectorAll(s).length; } catch { /* validated */ }
    }
    report(matched);
    return fresh.length;
  };

  // A cached or model-supplied rule is plain CSS, so isProtected never gets to
  // run on what it matches. Re-check once the DOM exists: a rule that turns out
  // to cover the login form or the article body is pulled back out, and the site
  // is re-learned rather than left with a rule that breaks it on every visit.
  const auditRemoteRules = () => {
    const bad = [];
    for (const sel of remoteSelectors) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      if (!nodes.length) continue;
      if (nodes.length > 8 || [...nodes].some(isProtected)) bad.push(sel);
    }
    if (!bad.length) return;
    bad.forEach((s) => { hiddenSelectors.delete(s); remoteSelectors.delete(s); });
    rebuildStyle();
    chrome.runtime.sendMessage({ type: "forget", host: HOST },
      () => void chrome.runtime.lastError);
  };

  // Remote rules can land before the DOM exists (from the storage mirror) or
  // well after DOMContentLoaded (from the host round trip), so the audit is tied
  // to the rules arriving rather than to any one point in the page lifecycle.
  const auditWhenReady = () => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", auditRemoteRules, { once: true });
    } else {
      auditRemoteRules();
    }
  };

  // A selector that still identifies this element on the next page load. Prefer
  // a stable id or class; fall back to a structural path, which is good enough
  // to hide something now but is never cached — ":nth-child(4)" means a
  // different element on the next page of the same site.
  const selectorFor = (el) => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const classes = [...el.classList]
      .filter((c) => /^[A-Za-z][\w-]*$/.test(c) && !/^(is|has)-/.test(c))
      // Hashed build classes (css-1x2y3z, sc-aBcDe) change on every deploy.
      .filter((c) => !/^[a-z]{2,3}-[a-z0-9]{5,}$/i.test(c));
    if (classes.length) {
      const sel = `${el.tagName.toLowerCase()}.${classes.slice(0, 3).join(".")}`;
      if (validSelector(sel)) return sel;
    }
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && path.length < 5 && node !== document.body) {
      const parent = node.parentElement;
      if (!parent) break;
      const idx = [...parent.children].indexOf(node) + 1;
      path.unshift(`${node.tagName.toLowerCase()}:nth-child(${idx})`);
      node = parent;
    }
    return path.length ? `body ${path.join(" > ")}` : null;
  };

  // Worth caching only if it names this element on the next visit too, and only
  // this one. A selector matching several elements would be a rule that hides
  // whatever else happens to share those classes — including a modal the user
  // opened on purpose.
  const cacheable = (sel) => {
    if (!sel || sel.includes(":nth-child")) return false;
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  };

  // Hide by inline style, not by a rule. A class-based selector for one overlay
  // ("div.fixed.inset-0.z-50") routinely matches the login modal the site opens
  // later, and a stylesheet rule would hide that too.
  const hideElement = (el) => {
    if (isProtected(el)) return false;
    el.style.setProperty("display", "none", "important");
    report(1);
    return true;
  };

  // A modal usually locks the page behind it. Removing the modal without
  // releasing the lock leaves a page that cannot scroll, which reads as a worse
  // bug than the popup itself.
  const releaseScrollLock = () => {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.overflow === "hidden" || cs.overflowY === "hidden" || cs.position === "fixed") {
        el.style.setProperty("overflow", "auto", "important");
        el.style.setProperty("position", "static", "important");
      }
    }
  };

  // ------------------------------------------------------------- layer 2: DOM

  const INTERRUPT_WORDS =
    /\b(accept (all )?cookies?|cookie (policy|consent|settings)|consent|gdpr|subscribe|newsletter|sign up for|create (a )?free account|allow notifications|disable your ad ?blocker|turn off your ad ?blocker|continue reading|you have \d+ free|special offer|limited time)\b/i;

  const CLOSE_WORDS = /\b(close|dismiss|no thanks|maybe later|not now|×|✕)\b/i;

  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id ? el.id.slice(0, 60) : "",
      cls: [...el.classList].slice(0, 6).join(" ").slice(0, 120),
      pos: cs.position,
      z: parseInt(cs.zIndex, 10) || 0,
      w: Math.round(r.width),
      h: Math.round(r.height),
      // Structure only, capped hard: enough for the model to tell a cookie wall
      // from a nav bar, never enough to reconstruct what the page said.
      text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120),
      links: el.querySelectorAll("a").length,
      inputs: el.querySelectorAll("input,button").length,
      iframes: el.querySelectorAll("iframe").length,
      area: Math.round((r.width * r.height) / (innerWidth * innerHeight) * 100),
    };
  };

  // "hide" act now · "ask" send to the model · "ok" settled, stop looking ·
  // null not ready — a popup that is still hidden will be revealed on a timer,
  // and that is exactly the case the later rescans exist for.
  const classify = (el) => {
    if (isProtected(el)) return "ok";

    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return null;

    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 30) return null;

    const z = parseInt(cs.zIndex, 10) || 0;
    const coverage = (r.width * r.height) / (innerWidth * innerHeight);
    const text = (el.innerText || "").slice(0, 2000);
    const interrupts = INTERRUPT_WORDS.test(text);
    const hasClose = CLOSE_WORDS.test(text) ||
      !!el.querySelector('[aria-label*="close" i],[class*="close" i],[data-dismiss]');

    // A near-fullscreen fixed layer stacked above the page is a modal or its
    // backdrop. Nothing else legitimately does this.
    if (coverage > 0.55 && z >= 100) return interrupts || hasClose ? "hide" : "ask";

    // A banner pinned to an edge that is asking for something.
    if (interrupts && z >= 10 && (coverage > 0.06 || hasClose)) return "hide";

    // Tall, high, and mostly links or an iframe: an ad rail rather than a UI bar.
    if (z >= 1000 && coverage > 0.15) return "ask";

    return "ok";
  };

  const scan = () => {
    if (!settings.enabled) return;
    const skipHeuristics = OMARCHY_HEURISTIC_SKIP.some(
      (h) => HOST === h || HOST.endsWith("." + h)
    );

    let hidAny = false;

    for (const el of document.querySelectorAll("body *")) {
      if (el.dataset.omarchyAdblockSeen) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;

      const verdict = skipHeuristics ? "ok" : classify(el);
      if (verdict === null) continue; // not settled yet — look again on the next pass
      el.dataset.omarchyAdblockSeen = "1";

      if (verdict === "hide") {
        if (hideElement(el)) hidAny = true;
      } else if (verdict === "ask" && settings.ai) {
        const sel = selectorFor(el);
        // Skip anything the model has already ruled on for this site, whether it
        // said block or leave alone. Without this, one legitimate sticky header
        // is an API call on every page load, forever.
        if (sel && cacheable(sel) && !alreadyAsked.has(sel) && !pendingCandidates.has(sel)) {
          pendingCandidates.add(sel);
        }
      }
    }

    if (hidAny) releaseScrollLock();
    if (pendingCandidates.size && !aiPassDone) askModel();
  };

  // ------------------------------------------------------------- layer 3: AI

  const askModel = () => {
    aiPassDone = true; // one classification per page; the verdicts are cached per site
    const selectors = [...pendingCandidates].slice(0, 25);
    const candidates = [];
    for (const sel of selectors) {
      let el;
      try { el = document.querySelector(sel); } catch { continue; }
      if (el) candidates.push({ selector: sel, ...describe(el) });
    }
    if (!candidates.length) return;

    chrome.runtime.sendMessage(
      { type: "classify", host: HOST, candidates },
      (reply) => {
        if (chrome.runtime.lastError || !reply) return;
        if (Array.isArray(reply.asked)) reply.asked.forEach((s) => alreadyAsked.add(s));
        if (Array.isArray(reply.block) && applySelectors(reply.block, true)) {
          auditWhenReady();
          releaseScrollLock();
        }
      }
    );
  };

  // ------------------------------------------------------------------- start

  const start = (cachedRules) => {
    applySelectors(OMARCHY_STATIC_SELECTORS, false);
    // Rules mirrored into extension storage are available synchronously enough
    // to land before first paint; the host round trip below only refreshes them.
    if (Array.isArray(cachedRules) && applySelectors(cachedRules, true)) auditWhenReady();

    chrome.runtime.sendMessage({ type: "rules", host: HOST }, (reply) => {
      if (chrome.runtime.lastError || !reply) return;
      if (Array.isArray(reply.asked)) reply.asked.forEach((s) => alreadyAsked.add(s));
      if (Array.isArray(reply.block) && applySelectors(reply.block, true)) auditWhenReady();
    });

    const run = () => { try { scan(); } catch (e) { /* never break the page */ } };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }

    // Popups appear on a timer or on scroll, long after load. Rescan on DOM
    // churn, throttled, so a busy page does not turn this into a hot loop.
    let pending = null;
    new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; run(); }, 400);
    }).observe(document.documentElement, { childList: true, subtree: true });

    [1500, 4000, 9000].forEach((ms) => setTimeout(run, ms));
  };

  chrome.storage.local.get(
    ["enabled", "ai", "allowlist", "rules:" + HOST],
    (s) => {
      settings = {
        enabled: s.enabled !== false,
        ai: s.ai !== false,
        allowlist: s.allowlist || [],
      };
      if (!settings.enabled) return;
      if (settings.allowlist.some((h) => HOST === h || HOST.endsWith("." + h))) return;
      start(s["rules:" + HOST]);
    }
  );
})();

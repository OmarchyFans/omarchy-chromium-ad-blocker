// omarchy-chromium-ad-blocker — content script.
//
// Everything here is built on one split: layers *mark* candidates, and a
// separate commit step *removes* them. That is what lets the same detection
// serve three different behaviours:
//
//   manual (default)  Nothing is touched until you ask. Hold the chord to see
//                     every ad the page is carrying; press Delete to remove them.
//   auto (opt-in)     Marks are committed as they arrive, so ads never paint.
//   picker            You point at something and call it an ad. That is a
//                     durable label for this site, not a guess.
//
// Detection runs cheapest-first and nothing waits on the layer behind it:
// static CSS selectors, then synchronous DOM heuristics, then the rules already
// learned for this site, and only what is left over goes to the model.

(() => {
  const HOST = location.hostname;
  const STYLE_ID = "omarchy-adblock-style";
  const UI_ID = "omarchy-adblock-ui";
  const MARK_ATTR = "data-omarchy-ad";
  const HIDE = "display:none!important;visibility:hidden!important;" +
               "opacity:0!important;pointer-events:none!important;";

  let settings = { enabled: true, ai: true, mode: "manual", allowlist: [], cookies: false };
  // With opt-in 2 on, a consent dialog is consent.js's to answer. Hiding it here
  // first would leave the site with no answer — it re-prompts next page — and
  // count a decline as an ad. So consent-shaped overlays wait a few seconds for
  // it; whatever is still showing after that is fair game.
  const CONSENT_SHAPED =
    /\b(cookies?|consent|gdpr|ccpa|your privacy|privacy preferences|legitimate interest|tracking|consentement|einwilligung|consentimiento|consenso|toestemming|consentimento)\b/i;
  const CONSENT_GRACE_MS = 6000;
  const consentSeenAt = new WeakMap();
  // A popup that is in the page but hidden (huffpost.com's campaign toaster)
  // is usually shown later by a class or style change, which the childList
  // observer never sees. Watch just those elements, and look again when they
  // change.
  const watchedHidden = new WeakSet();
  let hiddenPending = null;
  const hiddenObserver = new MutationObserver(() => {
    if (hiddenPending) return;
    hiddenPending = setTimeout(() => { hiddenPending = null; try { scan(); } catch { /* fine */ } }, 300);
  });
  const watchHidden = (el) => {
    if (watchedHidden.has(el)) return;
    watchedHidden.add(el);
    hiddenObserver.observe(el, { attributes: true, attributeFilter: ["class", "style", "hidden", "open", "aria-hidden"] });
  };
  const emptySince = new WeakMap();
  let aiPassDone = false;
  // What this site has already been asked about arrives over a round trip, and a
  // fast page finishes its first scan before it lands. Asking then would re-ask
  // the model about the same sticky header on every single page load.
  let rulesLoaded = false;

  // selector -> source, for everything we would remove. `user` and `static` are
  // never audited away; `cache` and `model` are.
  const marks = new Map();
  const markedEls = new Map();   // Element -> selector
  const committed = new Set();   // selectors already written to the stylesheet
  const alreadyAsked = new Set();
  const pendingCandidates = new Set();
  const settled = new WeakSet();

  // Automatic removal is on for every site, or for the sites the person picked
  // in the popup ("Clean this site automatically").
  const onList = (list) => (list || []).some((h) => HOST === h || HOST.endsWith("." + h));
  const auto = () => settings.mode === "auto" || onList(settings.autoSites);

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
    // Nothing inside a form. An agreement checkbox on a signup or a checkout is
    // not a popup; hiding it hides the terms without unbinding anyone from them,
    // and the site binds you on submit either way.
    if (el.closest("form")) return true;
    // The site's own header and navigation, and anything holding them. A sticky
    // header with a promo strip in it reads as a banner ad to the model; hiding
    // it takes the whole site's navigation with it.
    if (el.matches('header, nav, [role="banner"], [role="navigation"]')) return true;
    if (el.querySelector('nav, [role="navigation"]')) return true;
    // Never a bot check, or anything wrapping one (defined in consent.js).
    if (globalThis.OMARCHY_IS_CHALLENGE && globalThis.OMARCHY_IS_CHALLENGE(el)) return true;
    // Never hide something wrapping a login or payment field.
    if (el.querySelector('input[type="password"], input[autocomplete*="cc-"]')) return true;
    return false;
  };

  // Removals, as opposed to marks. Counted only when something actually goes,
  // so manual mode adds nothing to the totals until Delete is pressed. Batched,
  // because auto mode commits one mark at a time as a page loads.
  let committedPending = 0;
  let committedTimer = null;
  const countedEls = new WeakSet();
  const tally = (els) => {
    let n = 0;
    for (const el of els) {
      if (countedEls.has(el)) continue;
      countedEls.add(el);
      n++;
    }
    if (!n) return;
    committedPending += n;
    if (committedTimer) return;
    committedTimer = setTimeout(() => {
      const count = committedPending;
      committedPending = 0;
      committedTimer = null;
      chrome.runtime.sendMessage({ type: "committed", host: HOST, count },
        () => void chrome.runtime.lastError);
    }, 1500);
  };

  const report = () => {
    chrome.runtime.sendMessage(
      { type: "found", count: marks.size, mode: settings.mode },
      () => void chrome.runtime.lastError
    );
  };

  // ------------------------------------------------------------ mark / commit

  // Record that something is an ad. In auto mode that is immediately followed by
  // removing it; in manual mode the mark just sits there until the chord.
  const mark = (selector, source) => {
    if (!validSelector(selector)) return false;
    if (!marks.has(selector)) marks.set(selector, source);
    let nodes = [];
    try { nodes = [...document.querySelectorAll(selector)]; } catch { return false; }
    for (const el of nodes) {
      if (isProtected(el)) continue;
      markedEls.set(el, selector);
      el.setAttribute(MARK_ATTR, source);
    }
    if (auto()) {
      commit([selector]);
      tally(nodes.filter((el) => !isProtected(el)));
    }
    return true;
  };

  const markElement = (el, selector, source) => {
    if (isProtected(el)) return false;
    marks.set(selector, source);
    markedEls.set(el, selector);
    el.setAttribute(MARK_ATTR, source);
    if (auto()) {
      commitElement(el, selector);
      tally([el]);
      // A heuristic hide is an overlay; whatever it locked or blurred goes too.
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(releaseScrollLock, 50);
    }
    return true;
  };

  // With opt-in 2 on, a learned rule never reaches a consent platform's own
  // banner, even one inserted long after the rule was applied: it has to stay
  // visible to be answered. Rules the person picked by hand are left as they are.
  const rebuildStyle = () => {
    const consent = settings.cookies && globalThis.OMARCHY_CONSENT_UI_SELECTOR;
    styleEl().textContent = [...committed].map((s) => {
      const learned = !["user", "static"].includes(marks.get(s));
      return consent && learned
        ? `:is(${s}):not(${consent}):not(:is(${consent}) *):not(:has(${consent})){${HIDE}}`
        : `${s}{${HIDE}}`;
    }).join("\n");
  };

  // Some sites force a hidden element back with an inline
  // "display: flex !important" (repubblica.it's cookie wall), which beats any
  // stylesheet. For elements a rule matched, the hide is also written inline
  // and put back if the site takes it away — a few times, not forever.
  const reasserts = new WeakMap();
  const enforcer = new MutationObserver((records) => {
    if (!active()) return; // turned off or allowlisted: the restore must stick
    for (const { target: el } of records) {
      if (!markedEls.has(el) || !committed.has(markedEls.get(el))) continue;
      if (el.style.getPropertyValue("display") === "none" && el.style.getPropertyPriority("display") === "important") continue;
      const n = (reasserts.get(el) || 0) + 1;
      if (n > 10) continue;
      reasserts.set(el, n);
      el.style.setProperty("display", "none", "important");
    }
  });
  const enforceInline = (selector) => {
    let nodes = [];
    try { nodes = document.querySelectorAll(selector); } catch { return; }
    for (const el of nodes) {
      if (!markedEls.has(el) || isProtected(el)) continue;
      const inline = el.style.getPropertyValue("display");
      if (inline && inline !== "none" && el.style.getPropertyPriority("display") === "important") {
        el.style.setProperty("display", "none", "important");
      }
      enforcer.observe(el, { attributes: true, attributeFilter: ["style"] });
    }
  };

  const commit = (selectors) => {
    const fresh = selectors.filter((s) => validSelector(s) && !committed.has(s));
    if (!fresh.length) return 0;
    fresh.forEach((s) => committed.add(s));
    rebuildStyle();
    fresh.forEach(enforceInline);
    return fresh.length;
  };

  // A heuristic or picked element is hidden inline rather than by a rule: a
  // class-based selector for one overlay ("div.fixed.inset-0.z-50") routinely
  // matches the login modal the site opens later, and a stylesheet rule would
  // take that with it.
  const commitElement = (el, selector) => {
    el.style.setProperty("display", "none", "important");
  };

  // Remove everything currently marked. This is the only thing that hides.
  const commitAll = () => {
    const bySelector = [];
    for (const [selector, source] of marks) {
      if (source === "static" || source === "cache" || source === "model") {
        bySelector.push(selector);
      }
    }
    commit(bySelector);
    for (const [el, selector] of markedEls) {
      const source = marks.get(selector);
      if (source === "heuristic" || source === "user") commitElement(el, selector);
    }
    releaseScrollLock();
    return marks.size;
  };

  // A modal usually locks the page behind it. Removing the modal without
  // releasing the lock leaves a page that cannot scroll, which reads as a worse
  // bug than the popup itself.
  let releaseTimer = null;
  const releaseScrollLock = () => {
    // Defined by consent.js, which runs first in this same isolated world.
    if (globalThis.OMARCHY_UNLOCK_SCROLL) globalThis.OMARCHY_UNLOCK_SCROLL();
  };

  // A cached or model-supplied rule is plain CSS, so isProtected never gets to
  // run on what it matches. Re-check once the DOM exists.
  const isConsentUi = (el) =>
    !!(globalThis.OMARCHY_IS_CONSENT_UI && globalThis.OMARCHY_IS_CONSENT_UI(el));

  const auditRemoteRules = () => {
    const wrong = [];   // the rule itself is bad — unlearn the site
    const tooWide = []; // the rule is probably fine, this page just has many
    for (const [sel, source] of marks) {
      if (source !== "cache" && source !== "model") continue; // never a user's own
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      if (!nodes.length) continue;
      if ([...nodes].some(isProtected)) wrong.push(sel);
      // A consent banner learned as an ad, before opt-in 2 was on or by an older
      // build: skip it so it can be answered, without unlearning the site.
      else if (settings.cookies && [...nodes].some(isConsentUi)) tooWide.push(sel);
      else if (nodes.length > 8) tooWide.push(sel);
    }
    if (!wrong.length && !tooWide.length) return;

    // A rule learned from one ad slot on an article page can match fifteen on
    // the same site's homepage. Skipping it here is right; forgetting the whole
    // site over it would put the blocker in a loop.
    for (const sel of [...wrong, ...tooWide]) {
      marks.delete(sel);
      committed.delete(sel);
      for (const [el, s] of markedEls) {
        if (s === sel) { markedEls.delete(el); el.removeAttribute(MARK_ATTR); }
      }
    }
    rebuildStyle();
    if (wrong.length) {
      chrome.runtime.sendMessage({ type: "forget", host: HOST },
        () => void chrome.runtime.lastError);
    }
  };

  // A selector that still identifies this element on the next page load. Prefer
  // a stable id or class; fall back to a structural path, which is good enough
  // to hide something now but is never cached — ":nth-child(4)" means a
  // different element on the next page of the same site.
  const selectorFor = (el) => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const classes = [...el.classList]
      // Never our own. The picker highlights what you are pointing at, and a
      // selector built while that class is on the element would be remembered
      // as depending on it — and so would match nothing the moment the
      // highlight comes off.
      .filter((c) => !c.startsWith("omarchy-ad"))
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

  // Worth sending to the model only if it names this element on the next visit
  // too, and only this one.
  const cacheable = (sel) => {
    if (!sel || sel.includes(":nth-child")) return false;
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  };

  // ------------------------------------------------------------- layer 2: DOM

  const INTERRUPT_WORDS =
    /\b(accept (all )?cookies?|cookie (policy|consent|settings)|cookies?|cookiewall|consent|consentement|einwilligung|consentimiento|consenso|toestemming|consentimento|gdpr|subscribe|newsletter|sign up for|create (a )?free account|allow notifications|disable your ad ?blocker|turn off your ad ?blocker|continue reading|you have \d+ free|special offer|limited time)\b/i;

  // Sales offers are interruptions too: a subscription pitch, a discount, an app
  // install prompt. Only ever tested against fixed or sticky layers stacked over
  // the page, never against article text.
  const OFFER_WORDS =
    /\b((exclusive|special|limited[- ]time|introductory|welcome) offer|subscribe (now|today)|unlimited (digital )?access|(start|begin) (your )?(free )?trial|free trial|\d+% off|save \d+%|per (month|week|year)|\$\d+(\.\d\d)?( ?\/ ?| (for|a|per) )(mo|month|week|wk|year|yr)|get the app|download (our|the) app|open in (the )?app|become a (member|subscriber)|already a subscriber|sign in to (continue|keep reading)|register to (continue|keep reading)|unlock (this|all|full)|claim (your|this) (offer|deal|discount)|(fall|summer|spring|winter|holiday|flash|labor day|memorial day|black friday|cyber monday|anniversary) sale|save on (your|a) (first|subscription|digital)|subscribe for (just |only )?\$?\d|save the news|support (independent|quality|local|our|trusted) (journalism|reporting|news)|donate (now|today)|make a (contribution|donation)|contribute (now|today)|become a (supporter|member)|abonnez-vous|jetzt abonnieren|suscr[ií]bete|abbonati)\b/i;

  // An offer whose content lives in a frame shows the page no words at all, so
  // the frame's address is the tell: overlay and offer services, paywalls.
  const OFFER_FRAME =
    /\/overlay\/|\/offers?\b|paywall|regwall|\/subscribe|subscription|\/promo|tinypass\.com|piano\.io|zephr|poool\.fr|pelcro|\/meter\b|cxense/i;
  const hasOfferFrame = (el) =>
    [...el.querySelectorAll("iframe[src]")].some((f) => OFFER_FRAME.test(f.src));

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
      // Structure only, capped hard: enough to tell a cookie wall from a nav
      // bar, never enough to reconstruct what the page said.
      text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120),
      links: el.querySelectorAll("a").length,
      inputs: el.querySelectorAll("input,button").length,
      iframes: el.querySelectorAll("iframe").length,
      area: Math.round((r.width * r.height) / (innerWidth * innerHeight) * 100),
    };
  };

  // "hide" act now · "ask" send to the model · "ok" settled, stop looking ·
  // null not ready — a popup that is still hidden will be revealed on a timer.
  // A sticky wrapper holding the site's header is protected as a whole, but a
  // sales strip pinned inside it ("SALE: 6 months for 99¢ — unlimited digital
  // access") is not the header. Those parts go on their own: never the header
  // or navigation, nor anything inside or holding them.
  const offerPartsOf = (wrapper) => {
    const vw = innerWidth * innerHeight;
    const parts = [];
    for (const el of wrapper.querySelectorAll("div,section,aside,p,a")) {
      if (parts.some((p) => p.contains(el))) continue;
      if (el.closest('header, nav, [role="banner"], [role="navigation"], form')) continue;
      if (el.querySelector('header, nav, [role="banner"], [role="navigation"], input')) continue;
      const text = (el.innerText || "").slice(0, 400);
      if (!OFFER_WORDS.test(text)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < vw * 0.02) continue;
      parts.push(el);
    }
    return parts;
  };
  const wrapperText = new WeakMap();
  const holdsNavigation = (el) =>
    !el.matches('header, nav, [role="banner"], [role="navigation"]') &&
    !!el.querySelector('header, nav, [role="banner"], [role="navigation"]');

  const classify = (el) => {
    if (isProtected(el)) {
      if (holdsNavigation(el) && !el.closest("form")) {
        // One innerText read per pass; the parts are only walked when the
        // wrapper's text mentions an offer and has changed since last time.
        const text = (el.innerText || "").slice(0, 2000);
        if (!OFFER_WORDS.test(text) || wrapperText.get(el) === text) return null;
        wrapperText.set(el, text);
        for (const part of offerPartsOf(el)) {
          const sel = selectorFor(part);
          if (sel) markElement(part, sel, "heuristic");
        }
        // Not settled: a strip like this often appears only after scrolling.
        return null;
      }
      return "ok";
    }

    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
      watchHidden(el);
      return null;
    }

    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 30) return null;

    const z = parseInt(cs.zIndex, 10) || 0;
    const coverage = (r.width * r.height) / (innerWidth * innerHeight);
    const text = (el.innerText || "").slice(0, 2000);
    // The grace runs from when this dialog first showed up, not from page load:
    // a banner that arrives ten seconds in still gets its chance to be answered.
    if (settings.cookies && CONSENT_SHAPED.test(text) && !consentSeenAt.has(el)) {
      consentSeenAt.set(el, Date.now());
      // Look again when its grace is up, in case the page is quiet by then.
      setTimeout(() => { try { scan(); } catch { /* never break the page */ } }, CONSENT_GRACE_MS + 250);
    }
    if (settings.cookies && consentSeenAt.has(el) &&
        Date.now() - consentSeenAt.get(el) < CONSENT_GRACE_MS) {
      return null; // not settled — consent.js gets the first go
    }
    // Still empty: the offer or dialog that goes here has not rendered yet.
    // Leave it unsettled so the next pass sees what it becomes. Except a
    // full-screen layer that stays empty: that is the backdrop a popup left
    // behind (Piano's tp-backdrop, modality-overlay, a "scrim"), still dimming
    // the page and taking every click. After a few seconds it goes.
    if (!text.trim() && !el.querySelector("iframe,img,video,svg,canvas")) {
      // Only a layer that visibly dims or blurs the page, whether or not it
      // takes clicks. A transparent full-screen catcher is how an open menu
      // closes on an outside click, and stays.
      const alpha = (() => {
        const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor || "");
        if (!m) return 0;
        const parts = m[1].split(/[ ,/]+/).filter(Boolean);
        return parts.length > 3 ? parseFloat(parts[3]) : 1;
      })();
      const dims = alpha >= 0.05 || /blur\(/.test(cs.backdropFilter || "") || parseFloat(cs.opacity) < 1 && alpha > 0;
      if (coverage > 0.9 && z >= 100 && dims) {
        if (!emptySince.has(el)) emptySince.set(el, Date.now());
        if (Date.now() - emptySince.get(el) > 2500) return "hide";
        setTimeout(() => { try { scan(); } catch { /* fine */ } }, 2700);
      }
      return null;
    }
    const offer = OFFER_WORDS.test(text) || hasOfferFrame(el);
    const interrupts = INTERRUPT_WORDS.test(text) || offer;
    const hasClose = CLOSE_WORDS.test(text) ||
      !!el.querySelector('[aria-label*="close" i],[class*="close" i],[data-dismiss]');

    // A near-fullscreen fixed layer stacked above the page is a modal or its
    // backdrop. Nothing else legitimately does this.
    if (coverage > 0.55 && z >= 100) return interrupts || hasClose ? "hide" : "ask";

    // A banner pinned to an edge that is asking for something.
    if (interrupts && z >= 10 && (coverage > 0.06 || hasClose)) return "hide";
    // A sales pitch pinned over the page is an interruption at any size worth
    // noticing; a corner "subscribe for $1" box rarely bothers with a close button.
    if (offer && (z >= 1 || cs.position === "fixed") && coverage > 0.02) return "hide";

    // Tall, high, and mostly links or an iframe: an ad rail rather than a UI bar.
    if (z >= 1000 && coverage > 0.15) return "ask";

    return "ok";
  };

  const scan = () => {
    if (!settings.enabled) return;
    const skipHeuristics = OMARCHY_HEURISTIC_SKIP.some(
      (h) => HOST === h || HOST.endsWith("." + h)
    );

    for (const el of document.querySelectorAll("body *")) {
      if (settled.has(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") {
        // Settle it here. Leaving a static element unmarked means re-reading its
        // computed style on every pass — thousands of forced style recalcs every
        // 400ms on a large app. What that costs is a div that JS later makes
        // fixed, which is sticky-on-scroll navigation, not an ad.
        settled.add(el);
        continue;
      }

      const verdict = skipHeuristics ? "ok" : classify(el);
      if (verdict === null) continue; // not settled yet — look again next pass
      settled.add(el);

      if (verdict === "hide") {
        const sel = selectorFor(el);
        if (sel) markElement(el, sel, "heuristic");
      } else if (verdict === "ask" && settings.cookies && isConsentUi(el)) {
        // Past its grace and still unanswered: hide it for this visit only. No
        // model call and no cached rule, so next visit consent.js answers it.
        const sel = selectorFor(el);
        if (sel) markElement(el, sel, "heuristic");
      } else if (verdict === "ask" && settings.ai) {
        const sel = selectorFor(el);
        // Skip anything the model has already ruled on for this site, whether it
        // said block or leave alone. Without this, one legitimate sticky header
        // is a model call on every page load, forever.
        if (sel && cacheable(sel) && !alreadyAsked.has(sel) && !pendingCandidates.has(sel)) {
          pendingCandidates.add(sel);
        }
      }
    }

    // Static selectors are marked here rather than injected as CSS, because in
    // manual mode they must be visible-but-known, not gone.
    for (const sel of OMARCHY_STATIC_SELECTORS) {
      try {
        if (document.querySelector(sel)) mark(sel, "static");
      } catch { /* our own list */ }
    }

    report();
    if (rulesLoaded && pendingCandidates.size && !aiPassDone) askModel();
  };

  // ------------------------------------------------------------- layer 3: AI

  const askModel = () => {
    aiPassDone = true; // one classification per page; the verdicts are cached
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
        if (Array.isArray(reply.block)) {
          reply.block.forEach((s) => mark(s, "model"));
          auditRemoteRules();
          report();
          if (chordActive) refreshChordOutlines();
        }
      }
    );
  };

  // ------------------------------------------------------- chord: see, then go

  // Ctrl+Alt is clear of everything that matters here: Chromium reserves
  // Ctrl+Shift+Delete for clearing browsing data (the page never sees it),
  // Alt+Shift is a keyboard-layout toggle on many setups, and every Omarchy
  // Hyprland binding leads with SUPER.
  let chordActive = false;
  let priorZoom = "";
  let priorScroll = null;
  let hud = null;

  const uiStyle = () => {
    let el = document.getElementById(UI_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = UI_ID;
      (document.head || document.documentElement).appendChild(el);
      el.textContent = `
        [${MARK_ATTR}].omarchy-ad-lit {
          outline: 3px solid #ff4d4d !important;
          outline-offset: -3px !important;
          background-image: linear-gradient(135deg,
            rgba(255,77,77,.22) 25%, transparent 25%, transparent 50%,
            rgba(255,77,77,.22) 50%, rgba(255,77,77,.22) 75%,
            transparent 75%) !important;
          background-size: 12px 12px !important;
        }
        #omarchy-ad-hud {
          position: fixed; inset-block-end: 18px; inset-inline-start: 50%;
          transform: translateX(-50%);
          z-index: 2147483647; pointer-events: none;
          font: 600 13px/1.5 system-ui, sans-serif;
          color: #fff; background: #17171acc; backdrop-filter: blur(8px);
          border: 1px solid #ffffff26; border-radius: 10px;
          padding: 9px 15px; box-shadow: 0 6px 24px #0008;
          max-width: min(92vw, 560px); text-align: center;
        }
        #omarchy-ad-hud b { color: #ff8080; }
        #omarchy-ad-hud .k {
          display: inline-block; padding: 1px 6px; margin: 0 2px;
          border: 1px solid #ffffff40; border-radius: 5px;
          font-size: 11px; background: #ffffff14;
        }
        #omarchy-ad-picker {
          position: fixed; inset: 0; z-index: 2147483646;
          cursor: crosshair; background: transparent;
        }
      `;
    }
    return el;
  };

  // The HUD hangs off <html>, not <body>: the chord zooms the body out, and a
  // zoomed status bar would shrink along with the page it is describing.
  const showHud = (html) => {
    uiStyle();
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "omarchy-ad-hud";
      document.documentElement.appendChild(hud);
    }
    hud.innerHTML = html;
  };

  const hideHud = () => {
    if (hud) { hud.remove(); hud = null; }
  };

  // Already-removed marks are not offered again: pressing the chord twice on the
  // same page would otherwise report the same count for things that are gone.
  const litElements = () => [...markedEls.keys()].filter(
    (el) => el.isConnected && getComputedStyle(el).display !== "none"
  );

  const refreshChordOutlines = () => {
    for (const el of litElements()) el.classList.add("omarchy-ad-lit");
    const n = litElements().length;
    showHud(n
      ? `<b>${n}</b> ad${n === 1 ? "" : "s"} on this page · ` +
        `<span class="k">Delete</span> removes them · <span class="k">P</span> pick one by hand`
      : `No ads found here · <span class="k">P</span> pick one by hand`);
  };

  const enterChord = () => {
    if (chordActive || pickerActive || !settings.enabled) return;
    chordActive = true;
    uiStyle();
    // One last look before freezing the set, so a popup that appeared a moment
    // ago is included in what you are about to delete.
    try { scan(); } catch { /* never break the page */ }
    priorZoom = document.body.style.zoom || "";
    // Changing zoom re-lays out the document and drops the scroll position, so
    // it is put back by hand. Otherwise holding the chord halfway down an
    // article throws you to the top of it.
    priorScroll = { x: scrollX, y: scrollY };
    document.body.style.zoom = "0.6";
    refreshChordOutlines();
  };

  const restoreZoom = () => {
    document.body.style.zoom = priorZoom;
    if (priorScroll) {
      scrollTo(priorScroll.x, priorScroll.y);
      priorScroll = null;
    }
  };

  const exitChord = () => {
    if (!chordActive) return;
    chordActive = false;
    for (const el of [...markedEls.keys()]) el.classList.remove("omarchy-ad-lit");
    restoreZoom();
    hideHud();
  };

  const commitFromChord = () => {
    const lit = litElements();
    const n = lit.length;
    for (const el of [...markedEls.keys()]) el.classList.remove("omarchy-ad-lit");
    commitAll();
    tally(lit);
    restoreZoom();
    chordActive = false;
    if (n) {
      showHud(`Removed <b>${n}</b> ad${n === 1 ? "" : "s"}`);
      setTimeout(hideHud, 1600);
    } else {
      hideHud();
    }
    report();
  };

  // ------------------------------------------------- picker: point at an ad

  let pickerActive = false;
  let pickerOverlay = null;
  let pickTarget = null;
  let pickDepth = 0;
  // The arrow keys widen the selection without the mouse moving, so the last
  // cursor position has to be remembered: re-resolving from pickTarget instead
  // let pickDepth drift out of step with what was on screen, and the next
  // mousemove jumped somewhere unrelated.
  let pickPos = { x: 0, y: 0 };

  const outlinePick = (el) => {
    if (pickTarget) pickTarget.classList.remove("omarchy-ad-lit");
    pickTarget = el || null;
    if (!pickTarget) return;
    pickTarget.classList.add("omarchy-ad-lit");
    const sel = selectorFor(pickTarget) || "?";
    let matches = 1;
    try { matches = document.querySelectorAll(sel).length; } catch { /* fine */ }
    showHud(
      `<b>${pickTarget.tagName.toLowerCase()}</b> ${sel.slice(0, 60)}` +
      (matches > 1 ? ` · ${matches} like it` : "") +
      ` · <span class="k">click</span> remove · <span class="k">↑↓</span> resize · <span class="k">Esc</span> cancel`
    );
  };

  // Most real ads are cross-origin iframes, and a click inside one never
  // reaches this script. A transparent sheet over the whole viewport takes the
  // clicks instead, and elementsFromPoint says what is underneath it.
  const elementUnder = (x, y) => {
    const stack = document.elementsFromPoint(x, y).filter(
      (el) => el !== pickerOverlay && el.id !== "omarchy-ad-hud" &&
              el !== document.body && el !== document.documentElement
    );
    if (!stack.length) return null;
    let el = stack[0];
    for (let i = 0; i < pickDepth && el.parentElement &&
                    el.parentElement !== document.body; i++) {
      el = el.parentElement;
    }
    return el;
  };

  const enterPicker = () => {
    if (pickerActive) return;
    exitChord();
    pickerActive = true;
    pickDepth = 0;
    uiStyle();
    pickerOverlay = document.createElement("div");
    pickerOverlay.id = "omarchy-ad-picker";
    document.documentElement.appendChild(pickerOverlay);
    showHud(`Point at an ad · <span class="k">click</span> remove · <span class="k">Esc</span> cancel`);

    pickerOverlay.addEventListener("mousemove", (e) => {
      pickPos = { x: e.clientX, y: e.clientY };
      outlinePick(elementUnder(e.clientX, e.clientY));
    });
    pickerOverlay.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      confirmPick();
    });
    pickerOverlay.addEventListener("wheel", (e) => {
      e.preventDefault();
      pickPos = { x: e.clientX, y: e.clientY };
      stepDepth(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
  };

  // One way to change depth, so the keys and the wheel cannot disagree.
  const stepDepth = (delta) => {
    pickDepth = Math.max(0, pickDepth + delta);
    outlinePick(elementUnder(pickPos.x, pickPos.y));
  };

  const exitPicker = () => {
    if (!pickerActive) return;
    pickerActive = false;
    if (pickTarget) pickTarget.classList.remove("omarchy-ad-lit");
    pickTarget = null;
    if (pickerOverlay) { pickerOverlay.remove(); pickerOverlay = null; }
    hideHud();
  };

  const confirmPick = () => {
    const el = pickTarget;
    if (!el) return;
    if (isProtected(el)) {
      showHud("That one is protected — it holds a form or the page itself");
      setTimeout(() => { if (pickerActive) outlinePick(pickTarget); }, 1400);
      return;
    }
    const sel = selectorFor(el);
    el.classList.remove("omarchy-ad-lit");

    // A hand-marked selector is remembered for the whole class of thing, not
    // just the one element clicked: pointing at one ad slot should deal with its
    // siblings too. A positional path is the exception — it means something
    // different on the next page, so that one is only removed for this visit.
    const durable = !!sel && !sel.includes(":nth-child");
    let removed = 1;
    if (durable) {
      marks.set(sel, "user");
      try {
        for (const node of document.querySelectorAll(sel)) {
          if (!isProtected(node)) { commitElement(node, sel); removed++; }
        }
        removed--;
      } catch { commitElement(el, sel); }
      chrome.runtime.sendMessage({ type: "learn", host: HOST, selector: sel },
        () => void chrome.runtime.lastError);
    } else {
      commitElement(el, sel || "");
    }
    releaseScrollLock();
    tally([el]);
    exitPicker();
    showHud(
      durable
        ? `Removed ${removed > 1 ? removed + " elements" : "it"} and remembered <b>${sel.slice(0, 50)}</b> for ${HOST}`
        : `Removed it for this visit — no stable selector to remember`
    );
    setTimeout(hideHud, 2400);
    report();
  };

  // ----------------------------------------------------------------- keyboard

  const onKeyDown = (e) => {
    if (!settings.enabled) return;

    if (pickerActive) {
      if (e.key === "Escape") { e.preventDefault(); exitPicker(); }
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        stepDepth(e.key === "ArrowUp" ? 1 : -1);
      }
      return;
    }

    // Autorepeat would re-run the freeze-and-zoom on every tick.
    if (e.repeat) return;

    if (e.ctrlKey && e.altKey && !chordActive &&
        e.key !== "Delete" && e.key !== "p" && e.key !== "P") {
      enterChord();
      return;
    }
    if (!chordActive) return;

    // Delete only, deliberately. Ctrl+Alt+Backspace is the kill-the-session
    // chord on some setups, and this is not a key to train people to press.
    if (e.key === "Delete") {
      e.preventDefault();
      commitFromChord();
    } else if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      enterPicker();
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitChord();
    }
  };

  const onKeyUp = (e) => {
    // Letting go of either half of the chord puts the page back exactly as it
    // was. Nothing was removed unless Delete was pressed while holding.
    if (chordActive && (e.key === "Control" || e.key === "Alt" ||
                        !e.ctrlKey || !e.altKey)) {
      exitChord();
    }
  };

  // ------------------------------------------------------------------- start

  let started = false;
  const start = (cachedRules, userRules) => {
    if (started) return;
    started = true;
    if (Array.isArray(userRules)) userRules.forEach((s) => mark(s, "user"));

    // In auto mode the learned rules go in as CSS immediately, before the page
    // paints. In manual mode they are marks and nothing more.
    if (auto() && Array.isArray(cachedRules)) commit(cachedRules.filter(validSelector));

    chrome.runtime.sendMessage({ type: "rules", host: HOST }, (reply) => {
      rulesLoaded = true;
      if (chrome.runtime.lastError || !reply) return;
      if (Array.isArray(reply.asked)) reply.asked.forEach((s) => alreadyAsked.add(s));
      if (Array.isArray(reply.user)) reply.user.forEach((s) => mark(s, "user"));
      if (Array.isArray(reply.block)) {
        reply.block.forEach((s) => mark(s, "cache"));
        auditWhenReady();
      }
      report();
      // Anything the first scan queued up before this arrived is now safe to
      // ask about, minus whatever this reply already settled.
      for (const sel of [...pendingCandidates]) {
        if (alreadyAsked.has(sel)) pendingCandidates.delete(sel);
      }
      if (pendingCandidates.size && !aiPassDone) askModel();
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

    // 6500 is just past the consent grace period, so a dialog consent.js could
    // not answer is hidden promptly rather than waiting for the 9s pass.
    [1500, 4000, 6500, 9000].forEach((ms) => setTimeout(run, ms));

    // Offer strips and paywall prompts often appear after the reader scrolls,
    // by a class change the childList observer never sees. One pass per 1.5s
    // of scrolling, at most.
    let scrollPending = null;
    let scrollSettle = null;
    addEventListener("scroll", () => {
      // And once more after scrolling stops, for what animates in on arrival.
      clearTimeout(scrollSettle);
      scrollSettle = setTimeout(run, 900);
      if (scrollPending) return;
      scrollPending = setTimeout(() => { scrollPending = null; run(); }, 1500);
    }, { passive: true });

    addEventListener("keydown", onKeyDown, true);
    addEventListener("keyup", onKeyUp, true);
    // Alt-Tabbing away leaves the modifiers stuck down as far as the page knows.
    addEventListener("blur", () => { exitChord(); });
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Driven from the popup, which is the discoverable way in; the chord's P is
    // the fast one.
    if (msg.type === "enter-picker") { enterPicker(); sendResponse({ ok: true }); }
    else if (msg.type === "delete-all") { enterChord(); commitFromChord(); sendResponse({ ok: true }); }
    else if (msg.type === "preview") { enterChord(); sendResponse({ ok: true }); }
    return false;
  });

  const readSettings = (s, base = {}) => ({
    ...base,
    enabled: s.enabled !== false,
    ai: s.ai !== false,
    mode: s.mode === "auto" ? "auto" : "manual",
    allowlist: s.allowlist || [],
    autoSites: s.autoSites || [],
    cookies: s.cookies === true,
  });
  const KEYS = ["enabled", "ai", "mode", "allowlist", "autoSites", "cookies"];
  const active = () => settings.enabled && !onList(settings.allowlist);

  chrome.storage.local.get([...KEYS, "rules:" + HOST, "user:" + HOST], (s) => {
    settings = readSettings(s);
    if (!active()) return;
    start(s["rules:" + HOST], s["user:" + HOST]);
  });

  // Settings apply to the open page as soon as they change, without a reload:
  // turning on automatic removal (for every site or just this one) removes what
  // is already marked, turning the blocker on starts it, and turning it off or
  // allowlisting the site puts back what it hid.
  const hiddenInline = new Set();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !KEYS.some((k) => k in changes)) return;
    const wasActive = started && active();
    const wasAuto = auto();
    chrome.storage.local.get([...KEYS, "rules:" + HOST, "user:" + HOST], (s) => {
      settings = readSettings(s, settings);
      if (!active()) {
        if (!wasActive) return;
        styleEl().textContent = "";
        for (const el of markedEls.keys()) {
          if (el.style.getPropertyValue("display") === "none") {
            el.style.removeProperty("display");
            hiddenInline.add(el);
          }
        }
        return;
      }
      if (!started) {
        start(s["rules:" + HOST], s["user:" + HOST]);
        return;
      }
      rebuildStyle();
      if (!wasActive) {
        for (const el of hiddenInline) el.style.setProperty("display", "none", "important");
        hiddenInline.clear();
      }
      if (auto() && (!wasAuto || !wasActive)) {
        const els = [...markedEls.keys()];
        commitAll();
        tally(els);
        report();
      }
    });
  });
})();

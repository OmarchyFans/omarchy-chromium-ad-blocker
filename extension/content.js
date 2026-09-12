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

  let settings = { enabled: true, ai: true, mode: "manual", allowlist: [] };
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

  const auto = () => settings.mode === "auto";

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
    // Never hide something wrapping a login or payment field.
    if (el.querySelector('input[type="password"], input[autocomplete*="cc-"]')) return true;
    return false;
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
    if (auto()) commit([selector]);
    return true;
  };

  const markElement = (el, selector, source) => {
    if (isProtected(el)) return false;
    marks.set(selector, source);
    markedEls.set(el, selector);
    el.setAttribute(MARK_ATTR, source);
    if (auto()) commitElement(el, selector);
    return true;
  };

  const rebuildStyle = () => {
    styleEl().textContent =
      [...committed].map((s) => `${s}{${HIDE}}`).join("\n");
  };

  const commit = (selectors) => {
    const fresh = selectors.filter((s) => validSelector(s) && !committed.has(s));
    if (!fresh.length) return 0;
    fresh.forEach((s) => committed.add(s));
    rebuildStyle();
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

  // A cached or model-supplied rule is plain CSS, so isProtected never gets to
  // run on what it matches. Re-check once the DOM exists.
  const auditRemoteRules = () => {
    const wrong = [];   // the rule itself is bad — unlearn the site
    const tooWide = []; // the rule is probably fine, this page just has many
    for (const [sel, source] of marks) {
      if (source !== "cache" && source !== "model") continue; // never a user's own
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      if (!nodes.length) continue;
      if ([...nodes].some(isProtected)) wrong.push(sel);
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

  const litElements = () => [...markedEls.keys()].filter((el) => el.isConnected);

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
    const n = litElements().length;
    for (const el of [...markedEls.keys()]) el.classList.remove("omarchy-ad-lit");
    commitAll();
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
      outlinePick(elementUnder(e.clientX, e.clientY));
    });
    pickerOverlay.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      confirmPick();
    });
    pickerOverlay.addEventListener("wheel", (e) => {
      e.preventDefault();
      pickDepth = Math.max(0, pickDepth + (e.deltaY > 0 ? 1 : -1));
      outlinePick(elementUnder(e.clientX, e.clientY));
    }, { passive: false });
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
        pickDepth = Math.max(0, pickDepth + (e.key === "ArrowUp" ? 1 : -1));
        // Re-resolve from the element we are on rather than a cursor position
        // we do not have, so the keys work without moving the mouse.
        let el = pickTarget;
        if (e.key === "ArrowUp" && el && el.parentElement &&
            el.parentElement !== document.body) outlinePick(el.parentElement);
        else if (e.key === "ArrowDown" && el && el.firstElementChild)
          outlinePick(el.firstElementChild);
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

    if (e.key === "Delete" || e.key === "Backspace") {
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

  const start = (cachedRules, userRules) => {
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

    [1500, 4000, 9000].forEach((ms) => setTimeout(run, ms));

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

  chrome.storage.local.get(
    ["enabled", "ai", "mode", "allowlist", "rules:" + HOST, "user:" + HOST],
    (s) => {
      settings = {
        enabled: s.enabled !== false,
        ai: s.ai !== false,
        mode: s.mode === "auto" ? "auto" : "manual",
        allowlist: s.allowlist || [],
      };
      if (!settings.enabled) return;
      if (settings.allowlist.some((h) => HOST === h || HOST.endsWith("." + h))) return;
      start(s["rules:" + HOST], s["user:" + HOST]);
    }
  );
})();

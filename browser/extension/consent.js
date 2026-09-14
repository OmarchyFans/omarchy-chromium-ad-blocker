// Consent and legal notices.
//
// This runs before the ad layer on purpose. Hiding a cookie wall leaves the site
// with no answer, and a TCF site with no answer either assumes consent or asks
// again on the next page. Answering it — clicking the button that says no — is
// the thing that actually stops the asking, and it is the only version of this
// that makes the "declined" number mean anything.
//
// Three passes, cheapest first, same shape as the ad layer:
//   1. Known consent platforms, by the ids and classes they ship. Instant.
//   2. Anything else that looks like a consent dialog, by button text.
//   3. The local model, asked which of these buttons declines. Cached per site.

// Bot checks: DataDome, Cloudflare Turnstile, reCAPTCHA, hCaptcha, Arkose,
// PerimeterX. A challenge covers the page on purpose, and hiding it strands the
// person behind a blurred, unusable page with no way to pass. Neither layer ever
// touches one, or anything inside one. Shared with content.js.
const OMARCHY_CHALLENGE_HOSTS = /(^|\.)(captcha-delivery\.com|datadome\.co|challenges\.cloudflare\.com|hcaptcha\.com|arkoselabs\.com|funcaptcha\.com|px-cloud\.net|perimeterx\.net)$|^(www\.)?(google|recaptcha)\.(com|net)$/;
const OMARCHY_CHALLENGE_SELECTOR = [
  'iframe[src*="captcha-delivery.com"]', 'iframe[src*="datadome"]',
  'iframe[src*="challenges.cloudflare.com"]', 'iframe[src*="hcaptcha.com"]',
  'iframe[src*="recaptcha"]', 'iframe[src*="arkoselabs"]', 'iframe[src*="funcaptcha"]',
  '[id^="datadome"]', '[id^="ddv1-captcha"]', '.cf-turnstile', '.g-recaptcha', '.h-captcha',
  '#px-captcha', '[id^="px-captcha"]',
].join(",");
globalThis.OMARCHY_IS_CHALLENGE = (el) => {
  try {
    if (!el || !el.matches) return false;
    if (el.matches(OMARCHY_CHALLENGE_SELECTOR) || el.closest(OMARCHY_CHALLENGE_SELECTOR)) return true;
    return !!el.querySelector(OMARCHY_CHALLENGE_SELECTOR);
  } catch { return false; }
};

// Consent platforms' own containers. With opt-in 2 on, these are consent.js's
// to answer, so the ad layer never caches a rule for one or asks the model about
// one: a cached rule would hide the banner at the next page load, before it can
// be answered, and the site would never hear "no". Shared with content.js.
const OMARCHY_CONSENT_UI = [
  '[id^="onetrust"]', '#ot-sdk-btn-floating', '[id^="CybotCookiebot"]', '[id^="didomi"]',
  '.qc-cmp2-container', '[id^="qc-cmp2"]', '[id^="sp_message"]', '[class*="sp_message_container"]',
  '#usercentrics-root', '#usercentrics-cmp-ui', '[id^="truste"]', '#consent_blackbar', '.truste_overlay',
  '.cky-consent-container', '.cky-modal', '.osano-cm-window', '.osano-cm-dialog', '#termly-code-snippet-support',
  '.cmplz-cookiebanner', '#klaro', '.klaro', '#iubenda-cs-banner', '[id^="BorlabsCookie"]',
  '.cookiefirst-root', '.axeptio_widget', '#axeptio_overlay', '.fc-consent-root', '#cmpbox', '#cmpwrapper',
].join(",");
globalThis.OMARCHY_CONSENT_UI_SELECTOR = OMARCHY_CONSENT_UI;
globalThis.OMARCHY_IS_CONSENT_UI = (el) => {
  try {
    return !!el && !!el.matches && (el.matches(OMARCHY_CONSENT_UI) || !!el.closest(OMARCHY_CONSENT_UI) ||
      !!el.querySelector(OMARCHY_CONSENT_UI));
  } catch { return false; }
};

// A modal locks the page behind it, and removing the modal without the lock
// leaves a page that will not scroll. Sites lock in two ways: overflow:hidden on
// html/body, or body{position:fixed; top:-<scrollY>px; height:<viewport>} so the
// page cannot move at all. Both are undone here, the scroll position the site
// stashed in "top" is restored, and for a while afterwards the lock is undone
// again if the site's own script puts it back. Shared with content.js, which
// runs in the same isolated world.
globalThis.OMARCHY_UNLOCK_SCROLL = globalThis.OMARCHY_UNLOCK_SCROLL || (() => {
  let watching = false;
  const locked = (el) => {
    const cs = getComputedStyle(el);
    return cs.overflow === "hidden" || cs.overflowY === "hidden" ||
      cs.overflow === "clip" || cs.position === "fixed";
  };
  const release = () => {
    let restoreTo = null;
    for (const el of [document.documentElement, document.body]) {
      if (!el || !locked(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position === "fixed") {
        const top = parseFloat(cs.top);
        if (top < 0) restoreTo = -top;
      }
      // Visible on both lets the overflow propagate to the viewport, so the
      // window scrolls again instead of body becoming a scroll box of its own.
      el.style.setProperty("overflow", "visible", "important");
      el.style.setProperty("overflow-y", "visible", "important");
      el.style.setProperty("position", "static", "important");
      for (const prop of ["top", "left", "right", "bottom", "height", "width"]) {
        el.style.setProperty(prop, "auto", "important");
      }
      for (const prop of ["max-height", "max-width"]) {
        el.style.setProperty(prop, "none", "important");
      }
      el.dataset.omarchyUnlocked = "1";
    }
    if (restoreTo !== null) window.scrollTo(0, restoreTo);
    releaseBlur();
  };
  // The other thing a modal leaves behind: the page blurred behind it, either by
  // a filter on the content or by a text-less veil with backdrop-filter stacked
  // over it. Only large containers holding real text are un-blurred, so a
  // decorative blurred hero image keeps its look; only empty full-screen veils
  // are hidden, and never one wrapping a bot check.
  const releaseBlur = () => {
    if (!document.body) return;
    const vw = innerWidth * innerHeight;
    const containers = [document.documentElement, document.body, ...document.body.children];
    for (const top of [...document.body.children]) containers.push(...top.children);
    for (const el of containers) {
      if (!(el instanceof Element) || el.id?.startsWith("omarchy")) continue;
      const cs = getComputedStyle(el);
      if (!/blur\(/.test(cs.filter)) continue;
      if ((el.innerText || "").length < 200) continue;
      el.style.setProperty("filter", "none", "important");
      el.dataset.omarchyUnblurred = "1";
    }
    for (const el of document.querySelectorAll("body > *, body > * > *")) {
      if (el.id?.startsWith("omarchy") || globalThis.OMARCHY_IS_CHALLENGE(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" || cs.display === "none") continue;
      if (!/blur\(/.test(cs.backdropFilter || cs.webkitBackdropFilter || "")) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < vw * 0.55) continue;
      if ((el.innerText || "").trim().length > 20) continue;
      if (el.querySelector("iframe,input,button,a,video")) continue;
      el.style.setProperty("display", "none", "important");
      el.dataset.omarchyUnblurred = "1";
    }
  };
  return () => {
    release();
    if (watching || !document.body) return;
    watching = true;
    const mo = new MutationObserver(() => {
      if (locked(document.documentElement) || locked(document.body)) release();
    });
    const opts = { attributes: true, attributeFilter: ["style", "class"] };
    mo.observe(document.documentElement, opts);
    mo.observe(document.body, opts);
    setTimeout(() => { mo.disconnect(); watching = false; }, 20000);
  };
})();

(() => {
  const HOST = location.hostname;
  const TOP = window.top === window;
  // Inside a bot check's own frame there is nothing to decline or remove.
  if (OMARCHY_CHALLENGE_HOSTS.test(HOST)) return;

  let settings = { cookies: false, legal: false, enabled: true };
  let done = false;
  const legalSeen = new Map();

  // --------------------------------------------------------------- the list

  // Each entry is a consent platform and the button that means "no". Order
  // matters only in that the first match wins, and these do not overlap.
  const PLATFORMS = [
    // Not #onetrust-pc-btn-handler: that opens preferences without deciding
    // anything. Preferences are the second pass, below.
    { name: "onetrust",     reject: "#onetrust-reject-all-handler, .ot-pc-refuse-all-handler" },
    { name: "cookiebot",    reject: "#CybotCookiebotDialogBodyButtonDecline, #CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll" },
    { name: "didomi",       reject: "#didomi-notice-disagree-button, .didomi-continue-without-agreeing" },
    { name: "quantcast",    reject: ".qc-cmp2-summary-buttons > button:last-of-type, button[mode='secondary']" },
    { name: "usercentrics", reject: "#uc-deny-all-button, [data-testid='uc-deny-all-button'], button[data-testid='uc-deny-all-button']" },
    { name: "osano",        reject: ".osano-cm-denyAll, .osano-cm-button--type-deny" },
    { name: "cookieyes",    reject: ".cky-btn-reject, [data-cky-tag='reject-button']" },
    { name: "termly",       reject: "#displayPreferencesModal .t-declineAllButton, .t-declineAllButton" },
    { name: "complianz",    reject: ".cmplz-deny, .cc-deny" },
    { name: "klaro",        reject: ".cm-btn-decline, .cn-decline" },
    { name: "iubenda",      reject: ".iubenda-cs-reject-btn, #iubenda-cs-reject-btn" },
    { name: "sourcepoint",  reject: ".sp_choice_type_REJECT_ALL, button[title='Reject All']" },
    { name: "trustarc",     reject: ".rejectAll, #truste-consent-required" },
    { name: "borlabs",      reject: ".borlabs-cookie-refuse, ._brlbs-btn-refuse" },
    { name: "cookiefirst",  reject: "[data-cookiefirst-action='reject']" },
    { name: "axeptio",      reject: "#axeptio_btn_dismiss, .axeptio_btn_dismiss" },
  ];

  // "No" in the words sites actually use. Deliberately does not match a bare
  // "manage" or "settings" — opening a preferences pane is not an answer.
  // Not "save and exit": on a first screen with everything pre-ticked, that
  // button accepts. It is only safe after the switches are off, so it lives in
  // SAVE_TEXT for the preferences pass.
  const REJECT_TEXT =
    /^(\s*)(reject all|reject|decline all|decline|refuse all|refuse|deny all|deny|do not (accept|consent|sell|share)|don'?t accept|only (necessary|essential|required)|(necessary|essential|required) (cookies )?only|use necessary (cookies )?only|continue without (accepting|agreeing)|no,? thanks?|disagree|opt out|tout refuser|refuser tout|refuser|continuer sans accepter|alle ablehnen|ablehnen|nur (notwendige|erforderliche|essenzielle)( cookies)?( akzeptieren)?|rechazar todo|rechazar todas|rechazar|continuar sin aceptar|rifiuta tutto|rifiuta|continua senza accettare|alles weigeren|weigeren|alles afwijzen|afwijzen|rejeitar tudo|rejeitar|recusar|continuar sem aceitar|avvisa alla|avb[oö]j alla|neka alla)(\s*)$/i;

  // What a consent or legal dialog says about itself.
  const CONSENT_WORDS =
    /\b(cookie|cookies|consent|gdpr|ccpa|privacy preferences?|tracking|your privacy|we value your privacy|legitimate interest|data protection|consentement|vie priv[eé]e|einwilligung|datenschutz|consentimiento|privacidad|consenso|toestemming|consentimento|privacidade|samtycke)\b/i;

  const LEGAL_WORDS =
    /\b(terms (of (use|service)|and conditions)|privacy (policy|notice)|user agreement|eula|by (continuing|using this site|browsing)|we('ve| have) updated our (terms|privacy))\b/i;

  // ------------------------------------------------------------- DOM helpers

  // Consent platforms love a shadow root. querySelector does not cross one, so
  // a dialog that is plainly visible is invisible to a plain selector — the
  // single most common reason an auto-decline silently does nothing.
  const deepQueryAll = (selector, root = document, out = [], depth = 0) => {
    if (depth > 8) return out;
    try { out.push(...root.querySelectorAll(selector)); } catch { return out; }
    const walker = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of walker) {
      if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out, depth + 1);
    }
    return out;
  };

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    // The element may live in a same-origin frame's document.
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const cs = view.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  const textOf = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();

  // A click from script is not a trusted event. Most consent platforms accept it;
  // a few check isTrusted and will not. Nothing in a content script can forge
  // that, so when a decline does not take, the ad layer's hide is the fallback.
  const press = (el) => {
    if (!el || !visible(el)) return false;
    // No scrollIntoView: pressing a button near the footer would yank the
    // reader to the bottom of the page. Whatever scroll the click causes is
    // put back.
    const x = scrollX, y = scrollY;
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.click();
      if (TOP && (scrollX !== x || scrollY !== y)) scrollTo(x, y);
      return true;
    } catch {
      return false;
    }
  };

  const report = (kind, n, detail) => {
    if (n <= 0) return;
    chrome.runtime.sendMessage(
      { type: "consent-result", host: HOST, kind, count: n, detail },
      () => void chrome.runtime.lastError
    );
  };

  // ------------------------------------------------------ pass 1: the list

  const tryPlatforms = () => {
    for (const p of PLATFORMS) {
      for (const el of deepQueryAll(p.reject)) {
        if (press(el)) return p.name;
      }
    }
    return null;
  };

  // ---------------------------------------------------- pass 2: by the words

  // Dialog-shaped: stacked above the page, big enough to interrupt, and talking
  // about cookies. Everything else on the page is left alone.
  const consentDialogs = () => {
    const out = [];
    for (const el of deepQueryAll("div,section,aside,dialog,form")) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (globalThis.OMARCHY_IS_CHALLENGE(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 8000) continue;
      const text = textOf(el).slice(0, 600);
      if (!CONSENT_WORDS.test(text) && !LEGAL_WORDS.test(text)) continue;
      // Prefer the innermost match: a wrapper and its dialog both qualify.
      if (out.some((o) => o.contains(el))) {
        out.splice(out.findIndex((o) => o.contains(el)), 1);
      }
      out.push(el);
    }
    // Inside a consent platform's own frame the frame is the dialog, whether or
    // not anything in it is position:fixed.
    if (!TOP && !out.length && document.body && CONSENT_WORDS.test(textOf(document.body).slice(0, 1500))) {
      out.push(document.body);
    }
    // AppConsent (lefigaro.fr) writes its dialog into a frame with no src by
    // document.write, which replaces the frame's document after this script was
    // injected into it. The top frame can still reach a same-origin frame's
    // document, so it answers from here.
    if (TOP) {
      for (const f of document.querySelectorAll("iframe")) {
        let doc = null;
        try { doc = f.contentDocument; } catch { continue; }
        if (!doc || !doc.body || !visible(f)) continue;
        const fr = f.getBoundingClientRect();
        if (fr.width * fr.height < 8000) continue;
        if (CONSENT_WORDS.test(textOf(doc.body).slice(0, 1500))) out.push(doc.body);
      }
    }
    return out;
  };

  const buttonsIn = (dialog) =>
    deepQueryAll("button,a[role='button'],[role='button'],input[type='button'],input[type='submit']", dialog)
      .filter(visible)
      .filter((b) => {
        // Never a control inside a form the person is filling in. An agreement
        // checkbox on a signup is not a cookie banner, and clicking through it
        // on someone's behalf is the opposite of helping.
        const form = b.closest && b.closest("form");
        return !(form && form.querySelector("input[type=password],input[type=email],input[autocomplete*='cc-']"));
      });

  const tryGeneric = () => {
    for (const dialog of consentDialogs()) {
      for (const b of buttonsIn(dialog)) {
        const label = textOf(b).slice(0, 60);
        if (REJECT_TEXT.test(label) && press(b)) return label;
      }
    }
    return null;
  };

  // ---------------------------------------- pass 2b: into the preferences

  // Plenty of dialogs put no "reject" on the first screen, only "accept" and
  // "manage". The honest way through is the one a person would take: open the
  // preferences, switch off everything that can be switched off, and save.
  // Switches the site has disabled are the strictly necessary ones, so leaving
  // disabled controls alone is exactly "except those required to use the site".
  const SETTINGS_TEXT =
    /^\s*(manage( (my )?(options|preferences|settings|cookies|choices|privacy|consent))?|customi[sz]e|cookie (settings|preferences|choices)|settings|preferences|more options|options|let me choose|show purposes|(your |my )?privacy (choices|settings|preferences|options)|your (choices|options)|do not sell or share my personal information|param[eé]trer|personnaliser|g[eé]rer (mes )?(choix|pr[eé]f[eé]rences|cookies)|einstellungen|anpassen|cookie-einstellungen|configurar|personalizar|gestionar (cookies|preferencias)|impostazioni|personalizza|gestisci (le )?(preferenze|opzioni)|instellingen|aanpassen|gerenciar (cookies|prefer[eê]ncias)|inst[aä]llningar|anpassa)\s*$/i;
  const SAVE_TEXT =
    /^\s*(save( (and exit|preferences|settings|my choices?|choices?))?|confirm( my)? (choices?|selection|preferences)|submit preferences|allow selection|apply|done|reject all|refuse all|decline all|enregistrer( (mes choix|et quitter))?|valider( (mes choix|la s[eé]lection))?|confirmer( mes choix)?|speichern|auswahl (speichern|best[aä]tigen)|guardar( (preferencias|y salir))?|confirmar (selecci[oó]n|mis preferencias)|salva( (le )?(scelte|preferenze))?|conferma (le )?scelte|opslaan|keuze opslaan|salvar( prefer[eê]ncias)?|spara( (val|inst[aä]llningar))?)\s*$/i;
  // "Apply" and "Done" also close filter menus inside a vendor list; a button
  // that says save or confirm is always the better pick when both are there.
  const WEAK_SAVE = /^\s*(apply|done)\s*$/i;

  let openedPreferencesAt = 0;

  const switchesIn = (root) =>
    deepQueryAll("input[type='checkbox'],[role='switch'],[role='checkbox']", root).filter((el) => {
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      if (el.tagName === "INPUT") return el.checked;
      return el.getAttribute("aria-checked") === "true";
    });

  const tryPreferences = () => {
    const dialogs = consentDialogs();
    if (!dialogs.length) return null;

    // Second visit to this function, after the pane has had time to open.
    if (openedPreferencesAt && Date.now() - openedPreferencesAt > 500) {
      let turnedOff = 0;
      for (const dialog of dialogs) {
        for (const sw of switchesIn(dialog)) {
          try { sw.click(); turnedOff++; } catch { /* fine */ }
        }
      }
      const saves = dialogs.flatMap((dialog) => buttonsIn(dialog))
        .filter((b) => SAVE_TEXT.test(textOf(b)))
        .sort((a, b) => WEAK_SAVE.test(textOf(a)) - WEAK_SAVE.test(textOf(b)));
      for (const b of saves) {
        if (press(b)) return `preferences:${turnedOff} off`;
      }
      return null;
    }

    // Still waiting for the pane to open: say so, so the caller does not treat
    // this as "nothing here" and hand the page to the next pass.
    if (openedPreferencesAt) return "opening";
    for (const dialog of dialogs) {
      for (const b of buttonsIn(dialog)) {
        if (SETTINGS_TEXT.test(textOf(b)) && press(b)) {
          openedPreferencesAt = Date.now();
          return "opening";
        }
      }
    }
    return null;
  };

  // ------------------------------------------------------- pass 3: the model

  const selectorForButton = (b, i) => {
    if (b.id && /^[A-Za-z][\w-]*$/.test(b.id)) return `#${b.id}`;
    const cls = [...b.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 3);
    if (cls.length) {
      const sel = `${b.tagName.toLowerCase()}.${cls.join(".")}`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch { /* fine */ }
    }
    return `__idx:${i}`; // resolved against the same list we just built
  };

  const askModel = (dialogs) => {
    const buttons = [];
    const nodes = [];
    for (const dialog of dialogs) {
      for (const b of buttonsIn(dialog)) {
        if (buttons.length >= 12) break;
        nodes.push(b);
        buttons.push({
          selector: selectorForButton(b, nodes.length - 1),
          label: textOf(b).slice(0, 60),
          tag: b.tagName.toLowerCase(),
          cls: [...b.classList].slice(0, 4).join(" ").slice(0, 80),
        });
      }
    }
    if (!buttons.length) return;

    const dialogText = textOf(dialogs[0]).slice(0, 300);
    chrome.runtime.sendMessage(
      { type: "consent-classify", host: HOST, dialog: dialogText, buttons },
      (reply) => {
        if (chrome.runtime.lastError || !reply || !reply.selector) return;
        let el = null;
        const m = /^__idx:(\d+)$/.exec(reply.selector);
        if (m) el = nodes[Number(m[1])];
        else { try { el = document.querySelector(reply.selector); } catch { el = null; } }
        if (!el) el = nodes.find((n) => textOf(n).slice(0, 60) === reply.selector);
        if (press(el)) report("consent", 1, "model");
      }
    );
  };

  // -------------------------------------------- passive notices (no answer)

  // A banner that only informs — "by continuing you accept our terms", a cookie
  // notice with nothing but an OK — is removed rather than answered, because
  // there is nothing to answer. Anything wrapping a form is left exactly alone.
  const removePassive = () => {
    let n = 0;
    for (const el of consentDialogs()) {
      if (el.querySelector("form") || el.closest("form")) continue;
      // A sticky footer full of "Terms | Privacy" links matches the words and
      // offers no buttons, and it is the site's own furniture, not a popup.
      if (el.closest("footer,nav,header") || el.matches("footer,nav,header")) continue;
      if (el.querySelectorAll("a").length > 4) continue;
      if (el.querySelector("input,select,textarea")) continue;
      const buttons = buttonsIn(el);
      // If it can be declined, pass 1-3 should have done it; only take the ones
      // with no way to say no.
      if (buttons.some((b) => REJECT_TEXT.test(textOf(b)))) continue;
      if (buttons.length > 2) continue;
      // A site that puts the same notice straight back is counted once, and
      // after five returns it is left alone rather than fought on every frame.
      const sig = `${el.tagName}|${el.className}|${textOf(el).slice(0, 80)}`;
      const seen = (legalSeen.get(sig) || 0) + 1;
      legalSeen.set(sig, seen);
      if (seen > 5) continue;
      el.style.setProperty("display", "none", "important");
      el.setAttribute("data-omarchy-legal", "removed");
      if (seen === 1) n++;
      // The dialog often sits in a full-screen wrapper that is nothing but a
      // backdrop once the dialog is gone, and still takes every click.
      for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
        const ucs = getComputedStyle(up);
        if (ucs.position !== "fixed") continue;
        const r = up.getBoundingClientRect();
        if (r.width * r.height < innerWidth * innerHeight * 0.8) break;
        if ((up.innerText || "").trim()) break;
        up.style.setProperty("display", "none", "important");
      }
    }
    // Whatever it locked behind itself comes back with it.
    if (n && TOP) globalThis.OMARCHY_UNLOCK_SCROLL();
    return n;
  };

  // ------------------------------------------------------------------- run

  const run = () => {
    if (done || !settings.enabled) return;
    if (!settings.cookies && !settings.legal) return;

    if (settings.cookies) {
      const platform = tryPlatforms();
      if (platform) {
        done = true;
        report("consent", 1, platform);
        return;
      }
      const label = tryGeneric();
      if (label) {
        done = true;
        report("consent", 1, `text:${label}`);
        return;
      }
      const prefs = tryPreferences();
      if (prefs === "opening") return; // the next scheduled run finishes it
      if (prefs) {
        done = true;
        report("consent", 1, prefs);
        return;
      }
    }

    if (settings.legal) {
      const removed = removePassive();
      if (removed) report("legal", removed, "passive");
    }

    // Only the top frame asks the model: an iframe's dialog is handled by the
    // copy of this script running inside it, and two frames asking about the
    // same page would be two calls for one answer.
    if (settings.cookies && TOP) {
      const dialogs = consentDialogs();
      if (dialogs.length) {
        done = true;
        askModel(dialogs);
      }
    }
  };

  // Turning an opt-in on in the popup answers what is on the page right away,
  // instead of waiting for the next page load.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !["enabled", "cookies", "legal", "allowlist"].some((k) => k in changes)) return;
    chrome.storage.local.get(["enabled", "cookies", "legal", "allowlist"], (s) => {
      const turnedOn = (s.cookies === true && !settings.cookies) || (s.legal === true && !settings.legal) ||
        (s.enabled !== false && !settings.enabled);
      settings = { enabled: s.enabled !== false, cookies: s.cookies === true, legal: s.legal === true };
      const allow = s.allowlist || [];
      if (!settings.enabled || allow.some((h) => HOST === h || HOST.endsWith("." + h)) || !turnedOn) return;
      done = false;
      openedPreferencesAt = 0;
      [0, 800, 2000, 4000].forEach((ms) => setTimeout(() => { try { run(); } catch { /* fine */ } }, ms));
    });
  });

  chrome.storage.local.get(["enabled", "cookies", "legal", "allowlist"], (s) => {
    settings = {
      enabled: s.enabled !== false,
      cookies: s.cookies === true,
      legal: s.legal === true,
    };
    if (!settings.enabled) return;
    const allow = s.allowlist || [];
    if (allow.some((h) => HOST === h || HOST.endsWith("." + h))) return;

    // An embedded frame that cannot scroll itself but sets overscroll-behavior
    // (Tailwind's overscroll-none, common in audio and video players) swallows
    // the wheel: the page stops scrolling whenever the pointer is over it.
    // Only frames with nothing to scroll are changed, so an embed with its own
    // scrolling list keeps the site's behaviour.
    if (!TOP) {
      const letWheelThrough = () => {
        try {
          const H = document.documentElement, B = document.body;
          if (!H || !B) return;
          if (H.scrollHeight > innerHeight + 1 || B.scrollHeight > innerHeight + 1) return;
          const stuck = [H, B, ...B.querySelectorAll("*")].filter((el) => {
            const o = getComputedStyle(el).overscrollBehaviorY;
            return o && o !== "auto" && el.scrollHeight <= el.clientHeight + 1;
          });
          for (const el of stuck.slice(0, 50)) {
            el.style.setProperty("overscroll-behavior", "auto", "important");
          }
        } catch { /* never break the frame */ }
      };
      const soon = () => [0, 1000, 3000].forEach((ms) => setTimeout(letWheelThrough, ms));
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", soon, { once: true });
      } else {
        soon();
      }
    }

    const go = () => { try { run(); } catch { /* never break the page */ } };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", go, { once: true });
    } else {
      go();
    }
    // Consent platforms load themselves asynchronously and often arrive well
    // after the page is otherwise ready.
    [400, 1200, 2000, 2500, 3200, 5000].forEach((ms) => setTimeout(go, ms));

    // And some arrive later still, after a geolocation lookup or a scroll. Watch
    // for anything added that names itself a consent or legal dialog, and look
    // again as it animates in. Only the added node's own id, class and first
    // words are read, so a busy page costs a regex per insertion, not a scan.
    // Not "privacy" or "terms": on a news site half the teasers inserted while
    // scrolling mention one, and every match costs a full dialog scan.
    const SHAPED = /cookie|consent|onetrust|cmp|gdpr|ccpa|didomi|usercentrics|sp_message|truste|qc-cmp|iubenda|cookiebot|appconsent/i;
    let queued = false;
    let cycles = 0;
    const watcher = new MutationObserver((records) => {
      if (done || queued) return;
      if (++cycles > 12) { watcher.disconnect(); return; }
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (node.nodeType !== 1) continue;
          const tag = `${node.id} ${node.className && node.className.baseVal === undefined ? node.className : ""}`;
          if (SHAPED.test(tag) || SHAPED.test((node.textContent || "").slice(0, 400))) {
            queued = true;
            [300, 1500, 4000].forEach((ms, i) =>
              setTimeout(() => { if (i === 2) queued = false; go(); }, ms));
            return;
          }
        }
      }
    });
    const startWatching = () =>
      watcher.observe(document.documentElement, { childList: true, subtree: true });
    if (document.documentElement) startWatching();
    // Long enough for a slow platform; not forever on a page that never asks.
    setTimeout(() => watcher.disconnect(), 60000);
  });
})();

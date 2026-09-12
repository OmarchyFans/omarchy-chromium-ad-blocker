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

(() => {
  const HOST = location.hostname;
  const TOP = window.top === window;

  let settings = { cookies: false, legal: false, enabled: true };
  let done = false;

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
    /^(\s*)(reject all|reject|decline all|decline|refuse all|refuse|deny all|deny|do not (accept|consent|sell|share)|don'?t accept|only (necessary|essential|required)|(necessary|essential|required) (cookies )?only|use necessary (cookies )?only|continue without (accepting|agreeing)|no,? thanks?|disagree|opt out)(\s*)$/i;

  // What a consent or legal dialog says about itself.
  const CONSENT_WORDS =
    /\b(cookie|cookies|consent|gdpr|ccpa|privacy preferences?|tracking|your privacy|we value your privacy|legitimate interest|data protection)\b/i;

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
    const cs = getComputedStyle(el);
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
    try {
      el.scrollIntoView({ block: "center" });
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.click();
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
    /^\s*(manage( (options|preferences|settings|cookies))?|customi[sz]e|cookie settings|settings|preferences|more options|options|let me choose|show purposes)\s*$/i;
  const SAVE_TEXT =
    /^\s*(save( (and exit|preferences|settings|my choices|choices))?|confirm( my)? (choices|selection)|submit preferences|apply|done|reject all|refuse all|decline all)\s*$/i;

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
      for (const dialog of dialogs) {
        for (const b of buttonsIn(dialog)) {
          if (SAVE_TEXT.test(textOf(b)) && press(b)) {
            return `preferences:${turnedOff} off`;
          }
        }
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
      el.style.setProperty("display", "none", "important");
      n++;
    }
    if (n) {
      // Whatever it locked behind itself comes back with it.
      for (const el of [document.documentElement, document.body]) {
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (cs.overflow === "hidden" || cs.overflowY === "hidden") {
          el.style.setProperty("overflow", "auto", "important");
        }
      }
    }
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

  chrome.storage.local.get(["enabled", "cookies", "legal", "allowlist"], (s) => {
    settings = {
      enabled: s.enabled !== false,
      cookies: s.cookies === true,
      legal: s.legal === true,
    };
    if (!settings.enabled) return;
    const allow = s.allowlist || [];
    if (allow.some((h) => HOST === h || HOST.endsWith("." + h))) return;

    const go = () => { try { run(); } catch { /* never break the page */ } };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", go, { once: true });
    } else {
      go();
    }
    // Consent platforms load themselves asynchronously and often arrive well
    // after the page is otherwise ready.
    [400, 1200, 2000, 2500, 3200, 5000].forEach((ms) => setTimeout(go, ms));
  });
})();

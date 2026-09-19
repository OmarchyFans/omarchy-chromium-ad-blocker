// Omarchy Ad Blocker — service worker.
//
// The only thing in the extension that talks to the outside world. It owns a
// long-lived native-messaging port to omarchy-adblock-host, which holds the
// per-site rule cache on disk and makes the Claude call when the cache misses.
//
// The port is long-lived rather than one sendNativeMessage per request because
// a cache miss costs a round trip to the API — several seconds — and
// sendNativeMessage would have given up long before the answer came back.

const HOST_NAME = "com.omarchy.adblock";
const REQUEST_TIMEOUT_MS = 30000;

let port = null;
let nextId = 1;
const pending = new Map();

// Rules already fetched this browser session, so a second tab on the same site
// costs nothing at all.
const memCache = new Map();
const askedCache = new Map();
const userCache = new Map();
const foundCounts = new Map();

// Mirror a site's rules into extension storage. The content script reads this in
// the same storage call it already makes at document_start, so a known site is
// blocked before first paint instead of after a round trip to the host.
function mirror(host, block, user) {
  const patch = {};
  if (block) patch["rules:" + host] = block;
  if (user) patch["user:" + host] = user;
  chrome.storage.local.set(patch, () => void chrome.runtime.lastError);
}

function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    port = null;
    return null;
  }

  port.onMessage.addListener((msg) => {
    const entry = pending.get(msg && msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    entry.resolve(msg);
  });

  // The host exits on error, on a missing API key, or when Chromium tears the
  // pipe down. Fail every in-flight request rather than leave callers hanging;
  // the next request reconnects.
  port.onDisconnect.addListener(() => {
    port = null;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ id, block: [], error: "host-disconnected" });
    }
    pending.clear();
  });

  return port;
}

function ask(payload) {
  return new Promise((resolve) => {
    const p = connect();
    if (!p) return resolve({ block: [], error: "host-unavailable" });

    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ block: [], error: "timeout" });
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, timer });
    try {
      p.postMessage({ id, ...payload });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      port = null;
      resolve({ block: [], error: "post-failed" });
    }
  });
}

// The toolbar icon carries the answer to "is it on?": full colour with counts
// when it is on, grey with OFF when it is not.
async function showState() {
  const on = (await chrome.storage.local.get("enabled")).enabled === true;
  try {
    await chrome.action.setIcon({ path: on ? "icons/icon128.png" : "icons/icon128-off.png" });
  } catch (e) { /* icon missing: the title and badge still say it */ }
  await chrome.action.setTitle({
    title: on ? "Omarchy Chromium Ad Blocker — on" : "Omarchy Chromium Ad Blocker — off",
  });
  if (!on) {
    await chrome.action.setBadgeBackgroundColor({ color: "#8c8c94" });
    await chrome.action.setBadgeText({ text: "OFF" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
  return on;
}
let blockerOn = false;
const refreshState = () => showState().then((on) => { blockerOn = on; });
chrome.runtime.onStartup.addListener(refreshState);
chrome.runtime.onInstalled.addListener(refreshState);
refreshState();

function setBadge(tabId, n, mode) {
  if (!blockerOn) return; // the OFF badge is not a count to be overwritten
  if (!tabId) return;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" });
  // Amber while they are only marked and waiting for the chord; grey once
  // removing them is automatic and the number is just a tally.
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: mode === "auto" ? "#4a4a4a" : "#b26a00",
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;

  if (msg.type === "rules") {
    const cached = memCache.get(msg.host);
    if (cached) {
      sendResponse({
        block: cached,
        asked: askedCache.get(msg.host) || [],
        user: userCache.get(msg.host) || [],
      });
      return false;
    }
    ask({ op: "rules", host: msg.host }).then((reply) => {
      const block = Array.isArray(reply.block) ? reply.block : [];
      const asked = Array.isArray(reply.asked) ? reply.asked : [];
      const user = Array.isArray(reply.user) ? reply.user : [];
      memCache.set(msg.host, block);
      askedCache.set(msg.host, asked);
      userCache.set(msg.host, user);
      mirror(msg.host, block, user);
      sendResponse({ block, asked, user });
    });
    return true;
  }

  if (msg.type === "classify") {
    ask({
      op: "classify",
      host: msg.host,
      candidates: msg.candidates,
    }).then((reply) => {
      const block = Array.isArray(reply.block) ? reply.block : [];
      const asked = Array.isArray(reply.asked) ? reply.asked : [];
      if (block.length) {
        const merged = [...new Set([...(memCache.get(msg.host) || []), ...block])];
        memCache.set(msg.host, merged);
        mirror(msg.host, merged);
      }
      if (asked.length) askedCache.set(msg.host, asked);
      sendResponse({ block, asked });
    });
    return true;
  }

  // The badge counts what was *found*, which in auto mode is also what was
  // removed. In manual mode it is the standing offer: this many are waiting.
  if (msg.type === "found") {
    foundCounts.set(tabId, msg.count || 0);
    setBadge(tabId, msg.count || 0, msg.mode);
    return false;
  }

  if (msg.type === "learn") {
    ask({ op: "learn", host: msg.host, selector: msg.selector }).then((reply) => {
      const user = Array.isArray(reply.user) ? reply.user : [];
      userCache.set(msg.host, user);
      mirror(msg.host, null, user);
      sendResponse({ user });
    });
    return true;
  }

  if (msg.type === "status") {
    ask({ op: "status" }).then(sendResponse);
    return true;
  }

  if (msg.type === "forget") {
    memCache.delete(msg.host);
    askedCache.delete(msg.host);
    chrome.storage.local.remove("rules:" + msg.host,
      () => void chrome.runtime.lastError);
    ask({ op: "forget", host: msg.host }).then(sendResponse);
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => foundCounts.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    foundCounts.delete(tabId);
    setBadge(tabId, 0);
  }
});

// ===================================================================== privacy
//
// Everything below is driven by three settings, all off until someone turns
// them on: `cookies` (decline consent, block third-party trackers, sweep tracker
// cookies), `cookiesThirdParty` (also block every third-party cookie, which is a
// browser-wide change), and `legal` (handled in the content script). `history`
// keeps a local record of visits, meant for use alongside incognito.

// Tracker cookie names, not all cookies. Clearing everything for a domain would
// sign the person out of it, which is not what "block tracking" means.
const TRACKER_COOKIE = /^(_ga|_gid|_gat|_gcl_|__utm|_fbp|_fbc|fr$|_hj|ajs_|mp_|amplitude_|_uetsid|_uetvid|_clck|_clsk|_pin_unauth|_tt_|IDE$|test_cookie$|__qca|_scid|_rdt_uuid|muid$|anj$|uuid2$)/i;

let privacy = { cookies: false, cookiesThirdParty: false, history: false };

async function applyPrivacySettings() {
  const s = await chrome.storage.local.get(["enabled", "cookies", "cookiesThirdParty", "history"]);
  // Everything here is part of the blocker: with the blocker off, no tracker
  // rules, no Sec-GPC header and no cookie sweeping.
  const on = s.enabled === true;
  privacy = {
    cookies: on && s.cookies === true,
    cookiesThirdParty: s.cookiesThirdParty === true,
    history: on && s.history === true,
  };

  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      privacy.cookies
        ? { enableRulesetIds: ["trackers", "gpc"] }
        : { disableRulesetIds: ["trackers", "gpc"] }
    );
  } catch (e) { /* ruleset already in that state */ }

  // Global Privacy Control: the header above, plus navigator.globalPrivacyControl
  // for scripts that ask the page rather than read the request. It has to run in
  // the page's own world, so it is registered only while the opt-in is on.
  try {
    const have = await chrome.scripting.getRegisteredContentScripts({ ids: ["gpc"] });
    if (privacy.cookies && !have.length) {
      await chrome.scripting.registerContentScripts([{
        id: "gpc",
        js: ["gpc.js"],
        matches: ["http://*/*", "https://*/*"],
        runAt: "document_start",
        allFrames: true,
        world: "MAIN",
      }]);
    } else if (!privacy.cookies && have.length) {
      await chrome.scripting.unregisterContentScripts({ ids: ["gpc"] });
    }
  } catch (e) { /* registration raced a second call; the next change settles it */ }

  // Only ever set while this extension controls it, and cleared when turned off,
  // so the browser's own setting comes back rather than being left forced.
  try {
    if (privacy.cookies && privacy.cookiesThirdParty) {
      await chrome.privacy.websites.thirdPartyCookiesAllowed.set({ value: false });
    } else {
      await chrome.privacy.websites.thirdPartyCookiesAllowed.clear({});
    }
  } catch (e) { /* not controllable in this profile */ }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("enabled" in changes) refreshState();
  if ("enabled" in changes || "cookies" in changes || "cookiesThirdParty" in changes || "history" in changes) {
    applyPrivacySettings();
  }
});
chrome.runtime.onStartup.addListener(applyPrivacySettings);
chrome.runtime.onInstalled.addListener(applyPrivacySettings);
applyPrivacySettings();

function stat(host, counts) {
  if (!host) return;
  ask({ op: "stat", host, counts });
}

async function sweepTrackerCookies(url) {
  if (!privacy.cookies) return 0;
  let host;
  try { host = new URL(url).hostname; } catch { return 0; }
  let removed = 0;
  let cookies = [];
  // By URL, not by a guessed base domain: splitting off the last two labels
  // turns bbc.co.uk into co.uk, which matches every UK site's cookies.
  try { cookies = await chrome.cookies.getAll({ url }); } catch { return 0; }
  for (const c of cookies) {
    if (!TRACKER_COOKIE.test(c.name)) continue;
    const scheme = c.secure ? "https://" : "http://";
    const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
    try {
      await chrome.cookies.remove({ url: scheme + domain + c.path, name: c.name, storeId: c.storeId });
      removed++;
    } catch { /* already gone */ }
  }
  if (removed) stat(host, { trackers: removed });
  return removed;
}

// Network-rule matches. Counted by event where Chromium offers one (unpacked
// extensions, which is how this is installed), and otherwise by a slow poll:
// getMatchedRules allows only 20 calls per 10 minutes, and polling faster than
// that exhausts the quota in minutes and then fails silently for good.
const tabHosts = new Map();
// A blocked request is counted once per page. Some players retry a blocked
// config file in a loop, thousands of times a minute, and counting every retry
// would turn one tracker into a meaningless five-digit number.
const seenBlocked = new Map();
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) seenBlocked.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => { seenBlocked.delete(tabId); tabHosts.delete(tabId); });
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  const pending = new Map();
  let flushTimer = null;
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const tabId = info.request.tabId;
    if (tabId < 0) return;
    // Only the tracker list counts; the GPC rule matches every request.
    if (info.rule.rulesetId !== "trackers") return;
    let seen = seenBlocked.get(tabId);
    if (!seen) seenBlocked.set(tabId, (seen = new Set()));
    const url = info.request.url.split("?")[0];
    if (seen.has(url) || seen.size > 5000) return;
    seen.add(url);
    pending.set(tabId, (pending.get(tabId) || 0) + 1);
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      for (const [id, n] of pending) {
        let host = tabHosts.get(id);
        if (!host) {
          try { host = new URL((await chrome.tabs.get(id)).url).hostname; } catch { continue; }
        }
        stat(host, { trackers: n });
      }
      pending.clear();
    }, 2000);
  });
}
let lastMatchTs = Date.now();
async function countBlockedRequests() {
  if (!privacy.cookies || chrome.declarativeNetRequest.onRuleMatchedDebug) return;
  let info;
  try {
    info = await chrome.declarativeNetRequest.getMatchedRules({ minTimeStamp: lastMatchTs + 1 });
  } catch { return; }
  const perTab = new Map();
  for (const m of info.rulesMatchedInfo || []) {
    lastMatchTs = Math.max(lastMatchTs, m.timeStamp);
    if (m.rule.rulesetId !== "trackers") continue;
    perTab.set(m.tabId, (perTab.get(m.tabId) || 0) + 1);
  }
  for (const [tabId, n] of perTab) {
    if (tabId < 0) continue;
    try {
      const tab = await chrome.tabs.get(tabId);
      stat(new URL(tab.url).hostname, { trackers: n });
    } catch { /* tab closed */ }
  }
}
setInterval(countBlockedRequests, 60000);

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url || !/^https?:/.test(tab.url)) return;
  // A beat after load, so cookies set by scripts during load are there to sweep.
  try { tabHosts.set(tabId, new URL(tab.url).hostname); } catch { /* fine */ }
  setTimeout(() => sweepTrackerCookies(tab.url), 3000);
  // Sent for incognito tabs too, so `omarchy-adblock private on` works without
  // the popup; the host decides whether to keep it.
  if (privacy.history || tab.incognito) {
    ask({ op: "visit", url: tab.url, title: tab.title || "", requested: privacy.history });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const host = msg.host;

  if (msg.type === "consent-result") {
    stat(host, { [msg.kind === "legal" ? "legal" : "consent"]: msg.count || 1 });
    if (sender.tab && sender.tab.url) {
      // What was just declined may already have been set before the click.
      setTimeout(() => sweepTrackerCookies(sender.tab.url), 1500);
    }
    return false;
  }

  if (msg.type === "consent-classify") {
    ask({ op: "consent", host, dialog: msg.dialog, buttons: msg.buttons })
      .then((reply) => sendResponse({ selector: reply.selector || "" }));
    return true;
  }

  if (msg.type === "committed") {
    stat(host, { ads: msg.count || 0 });
    return false;
  }

  if (msg.type === "stats") {
    ask({ op: "stats" }).then(sendResponse);
    return true;
  }

  return false;
});

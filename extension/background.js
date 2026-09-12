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

function setBadge(tabId, n, mode) {
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

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
const blockedCounts = new Map();

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

function setBadge(tabId, n) {
  if (!tabId) return;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#4a4a4a" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;

  if (msg.type === "rules") {
    const cached = memCache.get(msg.host);
    if (cached) {
      sendResponse({ block: cached });
      return false;
    }
    ask({ op: "rules", host: msg.host }).then((reply) => {
      const block = Array.isArray(reply.block) ? reply.block : [];
      memCache.set(msg.host, block);
      sendResponse({ block });
    });
    return true;
  }

  if (msg.type === "classify") {
    ask({
      op: "classify",
      host: msg.host,
      url: msg.url,
      candidates: msg.candidates,
    }).then((reply) => {
      const block = Array.isArray(reply.block) ? reply.block : [];
      if (block.length) {
        const merged = new Set([...(memCache.get(msg.host) || []), ...block]);
        memCache.set(msg.host, [...merged]);
      }
      sendResponse({ block });
    });
    return true;
  }

  if (msg.type === "blocked") {
    const n = (blockedCounts.get(tabId) || 0) + (msg.count || 0);
    blockedCounts.set(tabId, n);
    setBadge(tabId, n);
    return false;
  }

  if (msg.type === "status") {
    ask({ op: "status" }).then(sendResponse);
    return true;
  }

  if (msg.type === "forget") {
    memCache.delete(msg.host);
    ask({ op: "forget", host: msg.host }).then(sendResponse);
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => blockedCounts.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    blockedCounts.delete(tabId);
    setBadge(tabId, 0);
  }
});

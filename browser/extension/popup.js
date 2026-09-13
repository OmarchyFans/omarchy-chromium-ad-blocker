// Popup: three opt-ins, the numbers behind them, and the ways to act now.

const $ = (id) => document.getElementById(id);

const registrableHost = (hostname) => {
  const parts = hostname.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : hostname;
};

const fmt = (n) => (n || 0).toLocaleString();

chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  let host = "";
  try { host = new URL(tab.url).hostname; } catch { /* chrome:// and friends */ }

  $("host").textContent = host || "not a web page";
  $("allowHost").textContent = host ? registrableHost(host) : "—";

  const s = await chrome.storage.local.get(
    ["enabled", "ai", "mode", "cookies", "cookiesThirdParty", "history", "legal", "allowlist"]);
  const allowKey = registrableHost(host);

  $("ads").checked = s.enabled !== false;
  $("mode").checked = s.mode === "auto";
  $("ai").checked = s.ai !== false;
  $("cookies").checked = s.cookies === true;
  $("cookiesThirdParty").checked = s.cookiesThirdParty === true;
  $("history").checked = s.history === true;
  $("legal").checked = s.legal === true;
  $("allow").checked = (s.allowlist || []).includes(allowKey);

  const syncBodies = () => {
    $("adsBody").hidden = !$("ads").checked;
    $("cookiesBody").hidden = !$("cookies").checked;
    $("legalBody").hidden = !$("legal").checked;
  };
  syncBodies();

  // Chromium will not let anything but the person grant incognito access, so
  // the most this can do is notice it has not been granted and say where.
  chrome.extension.isAllowedIncognitoAccess((allowed) => {
    $("incognitoNote").hidden = allowed || !$("history").checked;
  });

  // ---- numbers
  let scope = "site";
  let stats = null;
  const showStats = () => {
    const row = !stats ? {} : scope === "site" ? (stats.sites || {})[host] || {} : stats.totals || {};
    $("sAds").textContent = fmt(row.ads);
    $("sTrackers").textContent = fmt(row.trackers);
    $("sConsent").textContent = fmt(row.consent);
    $("sLegal").textContent = fmt(row.legal);
    $("scopeSite").setAttribute("aria-pressed", scope === "site");
    $("scopeAll").setAttribute("aria-pressed", scope === "all");
  };
  $("scopeSite").onclick = () => { scope = "site"; showStats(); };
  $("scopeAll").onclick = () => { scope = "all"; showStats(); };
  chrome.runtime.sendMessage({ type: "stats" }, (reply) => {
    void chrome.runtime.lastError;
    stats = reply && reply.totals ? reply : null;
    showStats();
  });

  chrome.action.getBadgeText({ tabId: tab.id }, (text) => {
    const n = parseInt(text, 10);
    $("count").textContent = n ? `(${n})` : "";
    if (!n) $("deleteAll").disabled = true;
  });

  // ---- act now. Each closes the popup, since each puts something on the page
  // the popup would be covering.
  const send = (type) => chrome.tabs.sendMessage(tab.id, { type }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
  $("deleteAll").onclick = () => send("delete-all");
  $("preview").onclick = () => send("preview");
  $("pick").onclick = () => send("enter-picker");

  // ---- settings. Most take effect on reload, because the layers that matter
  // run at document_start and flipping one mid-page would only half-apply.
  const reload = () => chrome.tabs.reload(tab.id);
  const bind = (id, key, map = (v) => v, reloadAfter = true) => {
    $(id).onchange = (e) => {
      chrome.storage.local.set({ [key]: map(e.target.checked) }, () => {
        syncBodies();
        if (reloadAfter) reload();
      });
    };
  };
  bind("ads", "enabled");
  bind("mode", "mode", (v) => (v ? "auto" : "manual"));
  bind("ai", "ai");
  bind("cookies", "cookies");
  bind("cookiesThirdParty", "cookiesThirdParty");
  bind("history", "history", (v) => v, false);
  bind("legal", "legal");

  $("allow").onchange = async (e) => {
    const cur = (await chrome.storage.local.get("allowlist")).allowlist || [];
    const next = e.target.checked
      ? [...new Set([...cur, allowKey])]
      : cur.filter((h) => h !== allowKey);
    chrome.storage.local.set({ allowlist: next }, reload);
  };

  $("forget").onclick = () => {
    if (!host) return;
    chrome.runtime.sendMessage({ type: "forget", host }, reload);
  };

  chrome.runtime.sendMessage({ type: "status" }, (reply) => {
    if (chrome.runtime.lastError || !reply) {
      $("status").textContent = "Native host not reachable — run install.sh.";
      return;
    }
    const where = reply.backend === "local" ? "Local GPU" : "Claude";
    if (!reply.ai_ready) {
      $("status").textContent = reply.backend === "local"
        ? "No local model answering — rules and heuristics only"
        : "No API key — rules and heuristics only";
    } else if (reply.last_error) {
      $("status").textContent = `${where} · last error: ` + reply.last_error.split("  ").pop();
    } else {
      $("status").textContent = `${where} ready · ${reply.cached_sites} site${reply.cached_sites === 1 ? "" : "s"} learned`;
    }
  });
});

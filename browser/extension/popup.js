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
    ["enabled", "ai", "mode", "cookies", "cookiesThirdParty", "history", "legal", "allowlist", "autoSites"]);
  const allowKey = registrableHost(host);

  $("ads").checked = s.enabled === true;
  $("mode").checked = s.mode === "auto";
  $("ai").checked = s.ai !== false;
  $("cookies").checked = s.cookies === true;
  $("cookiesThirdParty").checked = s.cookiesThirdParty === true;
  $("history").checked = s.history === true;
  $("legal").checked = s.legal === true;
  $("allow").checked = (s.allowlist || []).includes(allowKey);
  $("siteAutoHost").textContent = host ? allowKey : "this site";
  const syncSiteAuto = () => {
    const everywhere = $("mode").checked;
    $("siteAuto").disabled = everywhere || !host || !$("ads").checked;
    $("siteAuto").checked = everywhere || (s.autoSites || []).includes(allowKey);
    $("siteAutoSub").textContent = everywhere
      ? "Already on for every site"
      : "Every time you open it, starting now";
  };
  syncSiteAuto();

  // The switch at the top is the blocker itself: with it off nothing runs, so
  // the three settings are shown as unavailable rather than as promises.
  const syncBodies = () => {
    const on = $("ads").checked;
    $("master").classList.toggle("off", !on);
    $("masterState").textContent = on ? "Blocking is on" : "Blocking is off";
    $("masterSub").textContent = on
      ? "Ads, popups, trackers and legal notices"
      : "Nothing on any page is touched";
    $("offNote").hidden = on;
    $("adsBody").hidden = !on;
    $("cookiesBody").hidden = !on || !$("cookies").checked;
    $("legalBody").hidden = !on || !$("legal").checked;
    for (const id of ["cookies", "legal", "allow", "forget"]) $(id).disabled = !on;
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

  // ---- settings. Every change is applied to the open page as it lands, so
  // nothing here reloads the tab. A reload would raise Chromium's own
  // "Reload site?" prompt on any page with unsaved work, which reads as the
  // blocker asking for something and says nothing about whether it is on.
  const bind = (id, key, map = (v) => v) => {
    $(id).onchange = (e) => {
      chrome.storage.local.set({ [key]: map(e.target.checked) }, () => {
        syncBodies();
        syncSiteAuto();
        showStats();
      });
    };
  };
  bind("ads", "enabled");
  bind("mode", "mode", (v) => (v ? "auto" : "manual"));
  bind("ai", "ai");
  bind("cookies", "cookies");
  bind("cookiesThirdParty", "cookiesThirdParty");
  bind("history", "history");
  bind("legal", "legal");

  const toggleIn = async (key, on) => {
    const cur = (await chrome.storage.local.get(key))[key] || [];
    const next = on ? [...new Set([...cur, allowKey])] : cur.filter((h) => h !== allowKey);
    await chrome.storage.local.set({ [key]: next });
    s[key] = next;
  };
  $("siteAuto").onchange = (e) => toggleIn("autoSites", e.target.checked);
  // Leaving a site alone stops the blocker here and puts back what it hid. A
  // consent dialog it already answered stays answered; only a fresh load would
  // bring that back, and the note in the popup says so.
  $("allow").onchange = (e) => toggleIn("allowlist", e.target.checked);

  $("forget").onclick = () => {
    if (!host) return;
    chrome.runtime.sendMessage({ type: "forget", host }, () => {
      void chrome.runtime.lastError;
      // Put back what those rules were hiding, without a reload.
      chrome.tabs.sendMessage(tab.id, { type: "unlearn" }, () => void chrome.runtime.lastError);
      $("forget").textContent = "Forgotten — it will learn this site again";
    });
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

// Popup: the three switches a person actually reaches for, plus a way to throw
// away what the model learned about a site when it got something wrong.

const $ = (id) => document.getElementById(id);

const registrableHost = (hostname) => {
  const parts = hostname.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : hostname;
};

chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  let host = "";
  try { host = new URL(tab.url).hostname; } catch { /* chrome:// and friends */ }

  $("host").textContent = host || "not a web page";
  $("allowHost").textContent = host ? registrableHost(host) : "—";

  const s = await chrome.storage.local.get(["enabled", "ai", "allowlist"]);
  const allowlist = s.allowlist || [];
  const allowKey = registrableHost(host);

  $("enabled").checked = s.enabled !== false;
  $("ai").checked = s.ai !== false;
  $("allow").checked = allowlist.includes(allowKey);

  chrome.action.getBadgeText({ tabId: tab.id }, (text) => {
    const n = parseInt(text, 10);
    $("count").textContent = n ? `${n} element${n === 1 ? "" : "s"} blocked here` : "nothing blocked yet";
  });

  chrome.runtime.sendMessage({ type: "status" }, (reply) => {
    if (chrome.runtime.lastError || !reply) {
      $("status").textContent = "Native host not reachable — run install.sh.";
      return;
    }
    $("status").textContent = reply.ai_ready
      ? `Claude ready · ${reply.model} · ${reply.cached_sites} sites learned`
      : "No API key — heuristics only. See the README to enable Claude.";
  });

  // Any switch change needs a reload to take effect: the layers that matter run
  // at document_start, so flipping one mid-page would only half-apply.
  const reload = () => chrome.tabs.reload(tab.id);

  $("enabled").onchange = (e) =>
    chrome.storage.local.set({ enabled: e.target.checked }, reload);
  $("ai").onchange = (e) =>
    chrome.storage.local.set({ ai: e.target.checked }, reload);

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
});

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

  const s = await chrome.storage.local.get(["enabled", "ai", "mode", "allowlist"]);
  const allowlist = s.allowlist || [];
  const allowKey = registrableHost(host);

  $("enabled").checked = s.enabled !== false;
  $("ai").checked = s.ai !== false;
  $("mode").checked = s.mode === "auto";
  $("allow").checked = allowlist.includes(allowKey);

  chrome.action.getBadgeText({ tabId: tab.id }, (text) => {
    const n = parseInt(text, 10);
    $("count").textContent = n ? `(${n})` : "";
    if (!n) $("deleteAll").disabled = true;
  });

  // The three ways in. Each one closes the popup, because all of them put
  // something on the page that the popup would otherwise be covering.
  const send = (type) => chrome.tabs.sendMessage(tab.id, { type }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
  $("deleteAll").onclick = () => send("delete-all");
  $("preview").onclick = () => send("preview");
  $("pick").onclick = () => send("enter-picker");

  chrome.runtime.sendMessage({ type: "status" }, (reply) => {
    if (chrome.runtime.lastError || !reply) {
      $("status").textContent = "Native host not reachable — run install.sh.";
      return;
    }
    const where = reply.backend === "local" ? "Local GPU" : "Claude";
    if (!reply.ai_ready) {
      $("status").textContent = reply.backend === "local"
        ? `No model answering at ${reply.model} — heuristics only`
        : "No API key — heuristics only";
    } else if (reply.last_error) {
      // Better a visible complaint than a model pass quietly doing nothing.
      $("status").textContent =
        `${where} · last error: ` + reply.last_error.split("  ").pop();
    } else {
      $("status").textContent =
        `${where} · ${reply.cached_sites} site${reply.cached_sites === 1 ? "" : "s"} learned`;
    }
  });

  // Any switch change needs a reload to take effect: the layers that matter run
  // at document_start, so flipping one mid-page would only half-apply.
  const reload = () => chrome.tabs.reload(tab.id);

  $("enabled").onchange = (e) =>
    chrome.storage.local.set({ enabled: e.target.checked }, reload);
  $("ai").onchange = (e) =>
    chrome.storage.local.set({ ai: e.target.checked }, reload);
  $("mode").onchange = (e) =>
    chrome.storage.local.set({ mode: e.target.checked ? "auto" : "manual" }, reload);

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

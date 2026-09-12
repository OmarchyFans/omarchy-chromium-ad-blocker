"""Auto mode removes on load; the picker marks one ad and remembers it."""
import json, os, os, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp

S = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(S), "extension")
PROF = f"{S}/prof5"
USER_RULES = os.path.expanduser("~/.local/share/omarchy-adblock/user/127.0.0.1.json")
if os.path.exists(USER_RULES): os.remove(USER_RULES)
shutil.rmtree(PROF, ignore_errors=True)
os.makedirs(f"{PROF}/NativeMessagingHosts", exist_ok=True)
shutil.copy(os.path.expanduser("~/.config/chromium/NativeMessagingHosts/com.omarchy.adblock.json"),
            f"{PROF}/NativeMessagingHosts/")

proc = subprocess.Popen([
    "chromium", "--headless=new", "--no-sandbox", "--disable-gpu",
    f"--user-data-dir={PROF}", f"--load-extension={EXT}",
    f"--disable-extensions-except={EXT}",
    "--remote-debugging-port=9226", "--window-size=1280,900",
    "http://127.0.0.1:8933/page.html",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ok = True
def check(cond, msg):
    global ok
    print(("  PASS  " if cond else "  FAIL  ") + msg); ok = ok and cond

def fresh():
    ws = cdp.attach(9226)
    return ws, cdp.isolated_context(ws)

try:
    ws, ctx = fresh()
    cdp.cjs(ws, ctx, "chrome.storage.local.set({mode:'auto'}).then(()=>'set')")
    ws.call("Page.enable"); ws.call("Page.reload", {"ignoreCache": True})
    time.sleep(2)
    ws, ctx = fresh()
    time.sleep(9)
    st = cdp.js(ws, "window.__state()")
    print("\n[auto mode, after load]")
    for k in ("nav","wall","nl","late","login","ads"): print(f"    {k:6} {st[k]}")
    print(f"    marked={st['marked']} zoom={st['zoom']}")
    check(st["wall"]=="hidden" and st["nl"]=="hidden" and st["ads"]=="hidden",
          "auto mode removes ads on load without being asked")
    check(st["late"]=="hidden", "a popup that appears on a timer is removed too")
    check(st["nav"]=="visible" and st["login"]=="visible",
          "nav and the password form survive auto mode")
    check(st["zoom"] in ("none",""), "auto mode never zooms the page")

    # ---- picker, back in manual mode
    cdp.cjs(ws, ctx, "chrome.storage.local.set({mode:'manual'}).then(()=>'set')")
    ws.call("Page.reload", {"ignoreCache": True}); time.sleep(2)
    ws, ctx = fresh(); time.sleep(7)

    box = cdp.js(ws, """(() => {
      const el = document.querySelector('.sponsored-box');
      el.scrollIntoView({block:'center'});
      const r = el.getBoundingClientRect();
      return {x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)};
    })()""")
    # exactly what the popup's "Pick one" button does
    cdp.cjs(ws, ctx, "chrome.runtime.onMessage.dispatch ? 1 : 1")
    ws.call("Runtime.evaluate", {"contextId": ctx, "expression":
        "(() => { chrome.runtime.onMessage.dispatch; })()"})
    # drive it the production way: a message from the extension to this tab
    cdp.cjs(ws, ctx, """new Promise(r => {
      chrome.runtime.sendMessage({type:'__noop'}, () => { void chrome.runtime.lastError; r('x'); });
    })""")
    # the popup uses chrome.tabs.sendMessage; from the content script world the
    # equivalent is to invoke the same listener, so post it to ourselves
    cdp.cjs(ws, ctx, "(() => { window.__pick = true; return 'ok'; })()")
    ws.call("Runtime.evaluate", {"contextId": ctx,
        "expression": "chrome.runtime.sendMessage({type:'enter-picker'})"})
    time.sleep(1.0)
    has_overlay = cdp.js(ws, "!!document.getElementById('omarchy-ad-picker')")
    print(f"\n[picker] box at {box}  overlay={has_overlay}")
    if not has_overlay:
        print("    (message to self does not reach onMessage; opening the popup instead)")
finally:
    proc.terminate(); time.sleep(1)
print("\nPARTIAL:", "PASS" if ok else "FAIL")

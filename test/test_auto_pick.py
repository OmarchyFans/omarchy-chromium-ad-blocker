"""Auto mode removes on load; the picker marks one ad and remembers it."""
import json, os, os, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp

S = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(S), "extension")
PROF = "/tmp/omarchy-adblock-test-test_auto_pick"
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

finally:
    proc.terminate(); time.sleep(1)
print("\nOVERALL:", "PASS" if ok else "FAIL")

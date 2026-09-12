"""A hand-marked ad is still known on the next visit, in both modes."""
import json, os, os, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
S = os.path.dirname(os.path.abspath(__file__)); EXT = os.path.join(os.path.dirname(S), "extension")
PROF=f"{S}/prof8"; shutil.rmtree(PROF, ignore_errors=True)
os.makedirs(f"{PROF}/NativeMessagingHosts", exist_ok=True)
shutil.copy(os.path.expanduser("~/.config/chromium/NativeMessagingHosts/com.omarchy.adblock.json"), f"{PROF}/NativeMessagingHosts/")
U = os.path.expanduser("~/.local/share/omarchy-adblock/user/127.0.0.1.json")
print("user rules on disk before:", json.load(open(U))["block"] if os.path.exists(U) else None)

proc = subprocess.Popen(["chromium","--headless=new","--no-sandbox","--disable-gpu",
  f"--user-data-dir={PROF}",f"--load-extension={EXT}",f"--disable-extensions-except={EXT}",
  "--remote-debugging-port=9229","--window-size=1280,900","http://127.0.0.1:8933/page.html"],
  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
ok=True
def check(c,m):
    global ok; print(("  PASS  " if c else "  FAIL  ")+m); ok=ok and c
try:
    ws = cdp.attach(9229); ctx = cdp.isolated_context(ws); time.sleep(8)
    st = cdp.js(ws, """(() => {
      const b = document.querySelector('.sponsored-box');
      return {src: b.getAttribute('data-omarchy-ad'),
              disp: getComputedStyle(b).display,
              marked: document.querySelectorAll('[data-omarchy-ad]').length};
    })()""")
    print(f"\n[manual mode, fresh profile] {json.dumps(st)}")
    check(st["src"] == "user", "the hand-marked ad is recognised again, labelled as yours")
    check(st["disp"] == "block", "manual mode still waits for the chord before removing it")

    cdp.key(ws,"Control",True,ctrl=True); cdp.key(ws,"Alt",True,ctrl=True,alt=True); time.sleep(0.8)
    cdp.key(ws,"Delete",True,ctrl=True,alt=True); time.sleep(0.8)
    cdp.key(ws,"Alt",False,ctrl=True); cdp.key(ws,"Control",False); time.sleep(0.5)
    st2 = cdp.js(ws, "getComputedStyle(document.querySelector('.sponsored-box')).display")
    check(st2 == "none", "the chord removes it with everything else")

    cdp.cjs(ws, ctx, "chrome.storage.local.set({mode:'auto'}).then(()=>1)")
    ws.call("Page.enable"); ws.call("Page.reload", {"ignoreCache": True}); time.sleep(2)
    ws = cdp.attach(9229); time.sleep(8)
    st3 = cdp.js(ws, """(() => ({
      box: getComputedStyle(document.querySelector('.sponsored-box')).display,
      nav: getComputedStyle(document.getElementById('nav')).display,
    }))()""")
    print(f"\n[auto mode, same site] {json.dumps(st3)}")
    check(st3["box"] == "none", "auto mode removes the hand-marked ad on load")
    check(st3["nav"] != "none", "and still leaves the navigation alone")
finally:
    proc.terminate()
print("\nOVERALL:", "PASS" if ok else "FAIL")

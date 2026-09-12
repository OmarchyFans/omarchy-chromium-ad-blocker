"""Manual mode: nothing is removed until the chord, and Delete is what removes it."""
import json, os, subprocess, sys, time, shutil, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp

S = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(S), "extension")
PROF = f"{S}/prof"
shutil.rmtree(PROF, ignore_errors=True)
os.makedirs(f"{PROF}/NativeMessagingHosts", exist_ok=True)
shutil.copy(os.path.expanduser("~/.config/chromium/NativeMessagingHosts/com.omarchy.adblock.json"),
            f"{PROF}/NativeMessagingHosts/")

proc = subprocess.Popen([
    "chromium", "--headless=new", "--no-sandbox", "--disable-gpu",
    f"--user-data-dir={PROF}", f"--load-extension={EXT}",
    f"--disable-extensions-except={EXT}",
    "--remote-debugging-port=9222", "--window-size=1280,900",
    "http://127.0.0.1:8933/page.html",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def show(label, st):
    print(f"\n[{label}]")
    for k in ("nav","wall","nl","late","login","rail","ads"):
        print(f"    {k:6} {st[k]}")
    print(f"    marked={st['marked']} lit={st['lit']} zoom={st['zoom']} main={st['main']}")
    if st["hud"]: print(f"    hud: {st['hud'][:90]}")

try:
    ws = cdp.attach()
    cdp.js(ws, "1")
    time.sleep(9)   # let the late modal appear and the scans settle

    st0 = cdp.js(ws, "window.__state()")
    show("after load, manual mode — nothing should be hidden", st0)

    # hold Ctrl+Alt
    cdp.key(ws, "Control", True, ctrl=True)
    cdp.key(ws, "Alt", True, ctrl=True, alt=True)
    time.sleep(1.5)
    st1 = cdp.js(ws, "window.__state()")
    show("holding Ctrl+Alt — preview: zoomed out, ads outlined", st1)

    # release without Delete -> nothing removed
    cdp.key(ws, "Alt", False, ctrl=True)
    cdp.key(ws, "Control", False)
    time.sleep(0.8)
    st2 = cdp.js(ws, "window.__state()")
    show("released without Delete — page restored, nothing removed", st2)

    # hold again and press Delete
    cdp.key(ws, "Control", True, ctrl=True)
    cdp.key(ws, "Alt", True, ctrl=True, alt=True)
    time.sleep(1.0)
    cdp.key(ws, "Delete", True, ctrl=True, alt=True)
    time.sleep(1.0)
    st3 = cdp.js(ws, "window.__state()")
    show("Delete while held — ads removed", st3)
    cdp.key(ws, "Alt", False, ctrl=True); cdp.key(ws, "Control", False)

    print("\n================ RESULTS ================")
    ok = True
    def check(cond, msg):
        global ok
        print(("  PASS  " if cond else "  FAIL  ") + msg)
        ok = ok and cond

    check(st0["wall"]=="visible" and st0["nl"]=="visible" and st0["ads"]=="visible",
          "manual mode leaves everything on the page at load")
    check(st0["marked"] >= 3, f"ads were still detected and marked ({st0['marked']})")
    check(st1["zoom"]=="0.6", f"chord zooms the page out (zoom={st1['zoom']})")
    check(st1["lit"] >= 3, f"chord outlines the ads ({st1['lit']} lit)")
    check("Delete" in st1["hud"], "chord tells you how to finish it")
    check(st2["zoom"] in ("none",""), "releasing restores the zoom")
    check(st2["lit"]==0 and st2["wall"]=="visible", "releasing removes nothing")
    check(st3["wall"]=="hidden" and st3["nl"]=="hidden", "Delete removes the cookie wall and the popup")
    check(st3["ads"]=="hidden", "Delete removes the static ad slot too")
    check(st3["nav"]=="visible", "the site's navigation survives")
    check(st3["login"]=="visible", "the password form survives")
    check(st3["main"]!="none", "the article survives")
    print("=========================================")
    print("OVERALL:", "PASS" if ok else "FAIL")
finally:
    proc.terminate()

"""Picker: Ctrl+Alt then P, hover, click. Real key and mouse events throughout."""
import json, os, os, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp

S = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(S), "browser", "extension")
PROF = "/tmp/omarchy-adblock-test-test_picker"
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
    "--remote-debugging-port=9227", "--window-size=1280,900",
    "http://127.0.0.1:8933/page.html",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ok = True
def check(cond, msg):
    global ok
    print(("  PASS  " if cond else "  FAIL  ") + msg); ok = ok and cond

try:
    ws = cdp.attach(9227)
    cdp.js(ws, "1")
    # The blocker ships off; turn it on the way the popup does, then reload.
    cdp.cjs(ws, cdp.isolated_context(ws), "chrome.storage.local.set({enabled:true}).then(()=>1)")
    time.sleep(1)
    ws.call("Page.enable"); ws.call("Page.reload", {"ignoreCache": True})
    time.sleep(2)
    ws = cdp.attach(9227)
    time.sleep(8)

    # Clear the full-screen overlays first with the chord — otherwise the thing
    # on top at any coordinate is the cookie wall, which is correct but is not
    # what this test is trying to point at.
    cdp.key(ws, "Control", True, ctrl=True)
    cdp.key(ws, "Alt", True, ctrl=True, alt=True)
    time.sleep(0.8)
    cdp.key(ws, "Delete", True, ctrl=True, alt=True)
    time.sleep(0.8)
    cdp.key(ws, "Alt", False, ctrl=True); cdp.key(ws, "Control", False)
    time.sleep(0.8)

    # Ctrl+Alt to preview, then P to pick
    cdp.key(ws, "Control", True, ctrl=True)
    cdp.key(ws, "Alt", True, ctrl=True, alt=True)
    time.sleep(0.8)
    zoomed = cdp.js(ws, "document.body.style.zoom")
    cdp.key(ws, "p", True, ctrl=True, alt=True)
    time.sleep(0.8)
    cdp.key(ws, "p", False, ctrl=True, alt=True)
    cdp.key(ws, "Alt", False, ctrl=True); cdp.key(ws, "Control", False)
    time.sleep(0.5)

    state = cdp.js(ws, """(() => ({
      overlay: !!document.getElementById('omarchy-ad-picker'),
      zoom: document.body.style.zoom || 'none',
      hud: (document.getElementById('omarchy-ad-hud')||{}).textContent || '',
    }))()""")
    print(f"\n[picker entered]  overlay={state['overlay']} zoom={state['zoom']}")
    print(f"    hud: {state['hud'][:90]}")
    check(zoomed == "0.6", "chord previewed before the pick")
    check(state["overlay"], "P drops the click-catching overlay over the page")
    check(state["zoom"] in ("none", ""), "entering the picker un-zooms the page")

    # Read the coordinates only once the picker is open: entering it restores
    # the zoom, and a zoom change re-lays out the page.
    box = cdp.js(ws, """(() => {
      const el = document.querySelector('.sponsored-box');
      const r = el.getBoundingClientRect();
      return {x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)};
    })()""")
    print(f"    box centre: {box}")
    cdp.mouse(ws, box["x"], box["y"], "mouseMoved")
    time.sleep(0.6)
    hover = cdp.js(ws, """(() => ({
      hud: (document.getElementById('omarchy-ad-hud')||{}).textContent || '',
      lit: document.querySelectorAll('.omarchy-ad-lit').length,
    }))()""")
    print(f"\n[hover] lit={hover['lit']}  hud: {hover['hud'][:90]}")
    check(hover["lit"] == 1, "hovering outlines exactly what you are pointing at")
    check("sponsored" in hover["hud"], "the bar names the selector it would remember")
    print(f"    (pointing at: {hover['hud'].split(' · ')[0]})")

    # click to confirm
    cdp.mouse(ws, box["x"], box["y"], "mousePressed", "left")
    cdp.mouse(ws, box["x"], box["y"], "mouseReleased", "left")
    time.sleep(1.6)
    after = cdp.js(ws, """(() => ({
      box: getComputedStyle(document.querySelector('.sponsored-box')).display,
      hud: (document.getElementById('omarchy-ad-hud')||{}).textContent || '',
      overlay: !!document.getElementById('omarchy-ad-picker'),
      main: getComputedStyle(document.querySelector('main')).display,
      nav: getComputedStyle(document.getElementById('nav')).display,
    }))()""")
    print(f"\n[after click] {json.dumps(after)[:200]}")
    check(after["box"] == "none", "clicking removes the ad you pointed at")
    check(not after["overlay"], "the picker exits after the pick")
    check("remember" in after["hud"].lower(), "it tells you it will remember this one")
    check(after["main"] != "none" and after["nav"] != "none", "the page is otherwise untouched")

    # Esc cancels without removing
    cdp.key(ws, "Control", True, ctrl=True)
    cdp.key(ws, "Alt", True, ctrl=True, alt=True)
    time.sleep(0.5)
    cdp.key(ws, "p", True, ctrl=True, alt=True); cdp.key(ws, "p", False, ctrl=True, alt=True)
    time.sleep(0.5)
    cdp.mouse(ws, 640, 60, "mouseMoved"); time.sleep(0.4)
    cdp.key(ws, "Escape", True); cdp.key(ws, "Escape", False)
    cdp.key(ws, "Alt", False, ctrl=True); cdp.key(ws, "Control", False)
    time.sleep(0.6)
    esc = cdp.js(ws, """(() => ({
      overlay: !!document.getElementById('omarchy-ad-picker'),
      nav: getComputedStyle(document.getElementById('nav')).display,
      lit: document.querySelectorAll('.omarchy-ad-lit').length,
    }))()""")
    print(f"\n[esc] {json.dumps(esc)}")
    check(not esc["overlay"] and esc["nav"] != "none" and esc["lit"] == 0,
          "Esc leaves the picker having changed nothing")
finally:
    proc.terminate(); time.sleep(1.2)

print("\n[persistence]")
if os.path.exists(USER_RULES):
    d = json.load(open(USER_RULES))
    print("   ", USER_RULES)
    print("   ", json.dumps(d["block"]), "· source =", d.get("source"))
    check(any("sponsored" in s for s in d["block"]),
          "the hand-marked ad is written to disk for this site")
else:
    check(False, "the hand-marked ad is written to disk (no file)")
print("\nOVERALL:", "PASS" if ok else "FAIL")

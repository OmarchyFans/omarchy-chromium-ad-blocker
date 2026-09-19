"""The on/off switch in the popup: does it say which state it is in, flip the\nblocker on the open page, and show that state on the toolbar icon?"""
import base64, json, os, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
S = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(S), "browser", "extension")
ID = "fohhgkaemdiabgidgoajbgnccfccchac"
P = "/tmp/omarchy-adblock-test-switch"; H = P + "-home"; PORT = 9268
OUT = os.path.join(S, "smoke-out")
for d in (P, H): shutil.rmtree(d, ignore_errors=True)
os.makedirs(f"{P}/NativeMessagingHosts"); os.makedirs(f"{H}/.config/omarchy-adblock")
shutil.copy(os.path.expanduser("~/.config/omarchy-adblock/config.json"), f"{H}/.config/omarchy-adblock/")
shutil.copy(os.path.expanduser("~/.config/chromium/NativeMessagingHosts/com.omarchy.adblock.json"), f"{P}/NativeMessagingHosts/")
proc = subprocess.Popen(["/usr/lib/chromium/chromium", "--headless=new", "--disable-gpu", f"--user-data-dir={P}",
    f"--load-extension={EXT}", f"--disable-extensions-except={EXT}", f"--remote-debugging-port={PORT}",
    "--host-resolver-rules=MAP site.adtest.example 127.0.0.1", "--window-size=1280,900", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(os.environ, HOME=H))
ok = True
def check(c, m):
    global ok; print(("  PASS  " if c else "  FAIL  ") + m); ok = ok and c
def shot(pop, name):
    h = cdp.js(pop, "document.documentElement.scrollHeight")
    pop.call("Emulation.setDeviceMetricsOverride", {"width": 300, "height": h, "deviceScaleFactor": 2, "mobile": False})
    time.sleep(0.4)
    d = pop.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True})["data"]
    os.makedirs(OUT, exist_ok=True)
    open(os.path.join(OUT, name + ".png"), "wb").write(base64.b64decode(d))
try:
    ws = cdp.attach(PORT, match="about:blank")
    sw = cdp.attach_type(PORT, "service_worker")
    # Automatic removal chosen, but the blocker itself still off: the switch is
    # the only thing between this profile and a cleaned page.
    cdp.ajs(sw, "chrome.storage.local.set({mode:'auto'}).then(()=>1)"); time.sleep(1)
    ws.call("Page.enable"); ws.call("Page.navigate", {"url": "http://site.adtest.example:8933/page.html"}); time.sleep(5)
    page = cdp.attach(PORT, match="page.html")
    print("fresh profile · newsletter bar:", cdp.js(page, "getComputedStyle(document.getElementById('nl')).display"))
    ws.call("Target.createTarget", {"url": f"chrome-extension://{ID}/popup.html"}); time.sleep(2.5)
    pop = cdp.attach(PORT, match="popup.html")
    read = lambda: cdp.js(pop, """({state: document.getElementById('masterState').textContent,
        sub: document.getElementById('masterSub').textContent, on: document.getElementById('ads').checked,
        note: !document.getElementById('offNote').hidden,
        cookiesDisabled: document.getElementById('cookies').disabled,
        knob: getComputedStyle(document.querySelector('.track')).backgroundColor})""")
    before = read(); print("popup, off:", json.dumps(before))
    check(before["state"] == "Blocking is off" and not before["on"] and before["note"] and before["cookiesDisabled"],
          "with the blocker off the popup says so in words and greys out the settings")
    shot(pop, "switch-off")
    box = cdp.js(pop, "(() => { const r = document.querySelector('.switch').getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; })()")
    cdp.mouse(pop, box[0], box[1], "mousePressed", "left"); cdp.mouse(pop, box[0], box[1], "mouseReleased", "left")
    time.sleep(1.5)
    after = read(); print("popup, on: ", json.dumps(after))
    check(after["state"] == "Blocking is on" and after["on"] and not after["note"] and not after["cookiesDisabled"],
          "one click on the switch turns it on, and the settings come back")
    check(before["knob"] != after["knob"], "and the switch itself changes colour")
    shot(pop, "switch-on")
    time.sleep(2)
    check(cdp.js(page, "getComputedStyle(document.getElementById('nl')).display") == "none",
          "the open page is cleaned without being reloaded")
    st = cdp.ajs(sw, "chrome.action.getTitle({}).then(t => ({title: t}))")
    print("toolbar title:", st)
    check("on" in (st or {}).get("title", ""), "the toolbar tooltip says it is on")
    badge = cdp.ajs(sw, "chrome.action.getBadgeText({})")
    check(badge != "OFF", "and the OFF badge is gone")
    cdp.mouse(pop, box[0], box[1], "mousePressed", "left"); cdp.mouse(pop, box[0], box[1], "mouseReleased", "left")
    time.sleep(2)
    st2 = cdp.ajs(sw, "chrome.action.getTitle({}).then(t => t)")
    badge2 = cdp.ajs(sw, "chrome.action.getBadgeText({})")
    print("after switching off ·", st2, "| badge:", badge2)
    check("off" in (st2 or ""), "switching off again says off in the tooltip")
    check(badge2 == "OFF", "and the icon carries an OFF badge")
    check(cdp.js(page, "getComputedStyle(document.getElementById('nl')).display") != "none",
          "and what it hid comes back, still without a reload")
finally:
    proc.terminate()
print("\nOVERALL:", "PASS" if ok else "FAIL")

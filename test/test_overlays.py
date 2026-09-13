"""Overlays in auto mode: a popup's leftover blur goes with it, and a bot check is never touched."""
import json, os, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp

S = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(S), "extension")
PROF = "/tmp/omarchy-adblock-test-overlays"
PORT = 9262
shutil.rmtree(PROF, ignore_errors=True)
os.makedirs(f"{PROF}/NativeMessagingHosts", exist_ok=True)
shutil.copy(os.path.expanduser("~/.config/chromium/NativeMessagingHosts/com.omarchy.adblock.json"),
            f"{PROF}/NativeMessagingHosts/")

# Non-private names for every host, so neither the host's loopback exclusion
# nor third-party detection is fooled by everything being 127.0.0.1.
HOSTS = ["site.adtest.example", "geo.captcha-delivery.com", "cm.offers.example"]
proc = subprocess.Popen([
    "chromium", "--headless=new", "--no-sandbox", "--disable-gpu",
    f"--user-data-dir={PROF}", f"--load-extension={EXT}",
    f"--disable-extensions-except={EXT}",
    "--host-resolver-rules=" + ", ".join(f"MAP {h} 127.0.0.1" for h in HOSTS),
    f"--remote-debugging-port={PORT}", "--window-size=1280,900",
    "http://site.adtest.example:8933/page.html",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ok = True
def check(c, m):
    global ok
    print(("  PASS  " if c else "  FAIL  ") + m); ok = ok and c

def goto(ws, page, wait):
    ws.call("Page.enable")
    ws.call("Page.navigate", {"url": f"http://site.adtest.example:8933/{page}"})
    time.sleep(1.5)
    ws = cdp.attach(PORT, match=page)
    time.sleep(wait)
    return ws

try:
    ws = cdp.attach(PORT, match="page.html")
    ctx = cdp.isolated_context(ws)
    cdp.cjs(ws, ctx, "chrome.storage.local.set({mode:'auto', cookies:true, legal:true}).then(()=>1)")
    time.sleep(1.5)

    print("\n[a paywall popup that blurs the page behind it]")
    ws = goto(ws, "blur-modal.html", 9)
    st = cdp.js(ws, """(() => { const cs = (id) => getComputedStyle(document.getElementById(id));
        return {paywall: cs('paywall').display, veil: cs('veil').display,
                contentFilter: cs('content').filter, heroFilter: cs('hero').filter}; })()""")
    print("   ", st)
    check(st["paywall"] == "none", "the popup is removed")
    check(st["contentFilter"] == "none", "the blur it put on the article goes with it")
    check(st["veil"] == "none", "and so does the empty blurred veil over the page")
    check("blur" in st["heroFilter"], "a decorative blurred image keeps its look")

    print("\n[a bot check covering the page]")
    ws = goto(ws, "challenge.html", 10)
    st = cdp.js(ws, """(() => { const c = document.getElementById('ddv1-captcha-container');
        const f = document.getElementById('ddframe');
        return {container: getComputedStyle(c).display, frame: getComputedStyle(f).display,
                backdrop: getComputedStyle(c).backdropFilter, marked: c.hasAttribute('data-omarchy-ad')}; })()""")
    print("   ", st)
    check(st["container"] != "none" and st["frame"] != "none", "the challenge stays, so it can be passed")
    check("blur" in st["backdrop"] and not st["marked"], "nothing about it is marked or un-blurred")
    print("\n[sales offers, and the site's own header]")
    ws = goto(ws, "offer.html", 9)
    st = cdp.js(ws, """(() => { const d = (id) => getComputedStyle(document.getElementById(id)).display;
        return {frameOffer: d('offer_overlay'), lateOffer: d('offer_slide'), header: d('siteheader'),
                headerMarked: document.getElementById('siteheader').hasAttribute('data-omarchy-ad')}; })()""")
    print("   ", st)
    check(st["frameOffer"] == "none", "an offer that lives in an overlay frame is removed")
    check(st["lateOffer"] == "none", "an offer box that fills in after it appears is removed")
    check(st["header"] != "none" and not st["headerMarked"], "the site's header and navigation stay, promo strip and all")
finally:
    proc.terminate()

print("\nOVERALL:", "PASS" if ok else "FAIL")

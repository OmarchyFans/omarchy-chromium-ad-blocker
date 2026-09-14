"""Settings apply to the open page without a reload, and a site can be cleaned
automatically on its own while automatic removal is off everywhere else."""
import json, os, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp

S = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(S), "browser", "extension")
PROF = "/tmp/omarchy-adblock-test-live"
PORT = 9264
shutil.rmtree(PROF, ignore_errors=True)
os.makedirs(f"{PROF}/NativeMessagingHosts", exist_ok=True)
shutil.copy(os.path.expanduser("~/.config/chromium/NativeMessagingHosts/com.omarchy.adblock.json"),
            f"{PROF}/NativeMessagingHosts/")

# Non-private names for every host, so neither the host's loopback exclusion
# nor third-party detection is fooled by everything being 127.0.0.1.
HOSTS = ["site.adtest.example", "late.adtest.example", "www.google-analytics.com"]
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

def wait_for(ws, expr, want, seconds=6):
    end = time.time() + seconds
    val = None
    while time.time() < end:
        val = cdp.js(ws, expr)
        if val == want:
            return val
        time.sleep(0.25)
    return val

NL = "getComputedStyle(document.getElementById('nl')).display"
NAVS = "location.href"

def store(ws, obj):
    cdp.cjs(ws, cdp.isolated_context(ws), f"chrome.storage.local.set({json.dumps(obj)}).then(()=>1)")

try:
    ws = cdp.attach(PORT, match="page.html")
    store(ws, {"mode": "manual", "autoSites": [], "cookies": False, "legal": False, "ai": False})
    ws = goto(ws, "page.html", 5)

    print("\n[manual: nothing goes on its own]")
    check(cdp.js(ws, NL) != "none", "in manual mode the newsletter bar is only marked, not removed")
    href = cdp.js(ws, NAVS)

    print("\n[turning on automatic removal, no reload]")
    store(ws, {"mode": "auto"})
    check(wait_for(ws, NL, "none") == "none", "the open page is cleaned as soon as automatic removal is turned on")
    check(cdp.js(ws, "performance.getEntriesByType('navigation')[0].type") != "reload" and cdp.js(ws, NAVS) == href,
          "and the page was not reloaded to do it")

    print("\n[this site only]")
    store(ws, {"mode": "manual"})
    ws = goto(ws, "page.html", 4)
    check(cdp.js(ws, NL) != "none", "back in manual mode, a fresh load leaves it")
    store(ws, {"autoSites": ["site.adtest.example"]})
    check(wait_for(ws, NL, "none") == "none", "adding the site to 'clean this site automatically' cleans it now")
    ws = goto(ws, "page.html", 4)
    check(cdp.js(ws, NL) == "none", "and on every later visit, while automatic removal is off elsewhere")

    print("\n[turning the blocker off and on, no reload]")
    store(ws, {"enabled": False})
    end = time.time() + 6
    while time.time() < end and cdp.js(ws, NL) == "none":
        time.sleep(0.25)
    check(cdp.js(ws, NL) != "none", "turning the blocker off puts back what it hid")
    store(ws, {"enabled": True})
    check(wait_for(ws, NL, "none") == "none", "and turning it on again removes it again")
    store(ws, {"autoSites": []})

    print("\n[turning on consent handling, no reload]")
    ws = goto(ws, "consent-onetrust.html", 4)
    check((cdp.js(ws, "document.documentElement.dataset.consent") or "none") == "none", "with opt-in 2 off, the banner is left alone")
    store(ws, {"cookies": True})
    got = wait_for(ws, "document.documentElement.dataset.consent || 'none'", "rejected", 8)
    check(got == "rejected", "turning opt-in 2 on declines the banner already on the page")
finally:
    proc.terminate()

print("\nOVERALL:", "PASS" if ok else "FAIL")

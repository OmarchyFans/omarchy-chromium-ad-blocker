"""Opt-ins 2 and 3: consent is declined, trackers are blocked, legal notices go,
and a form's agreement checkbox is never touched."""
import json, os, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp

S = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(S), "extension")
PROF = "/tmp/omarchy-adblock-test-privacy"
PORT = 9260
shutil.rmtree(PROF, ignore_errors=True)
os.makedirs(f"{PROF}/NativeMessagingHosts", exist_ok=True)
shutil.copy(os.path.expanduser("~/.config/chromium/NativeMessagingHosts/com.omarchy.adblock.json"),
            f"{PROF}/NativeMessagingHosts/")

# Non-private names for every host, so neither the host's loopback exclusion
# nor third-party detection is fooled by everything being 127.0.0.1.
HOSTS = ["site.adtest.example", "www.google-analytics.com"]
proc = subprocess.Popen([
    "chromium", "--headless=new", "--no-sandbox", "--disable-gpu",
    f"--user-data-dir={PROF}", f"--load-extension={EXT}",
    f"--disable-extensions-except={EXT}",
    "--host-resolver-rules=" + ", ".join(f"MAP {h} 127.0.0.1" for h in HOSTS),
    f"--remote-debugging-port={PORT}", "--window-size=1280,900",
    "http://site.adtest.example:8933/legal.html",
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
    ws = cdp.attach(PORT, match="legal.html")

    print("\n[defaults: both opt-ins off]")
    ws = goto(ws, "consent-onetrust.html", 6)
    st = cdp.js(ws, """({consent: document.documentElement.dataset.consent || 'none',
        banner: !!document.getElementById('onetrust-banner-sdk')})""")
    print("   ", st)
    check(st["consent"] == "none" and st["banner"],
          "with the opt-in off, nothing is clicked on anyone's behalf")
    ws = goto(ws, "legal.html", 1)

    ctx = cdp.isolated_context(ws)
    cdp.cjs(ws, ctx, "chrome.storage.local.set({cookies:true, legal:true}).then(()=>1)")
    time.sleep(1.5)  # let the worker switch the tracker ruleset on
    sw = cdp.attach_type(PORT, "service_worker")
    rulesets = cdp.ajs(sw, "chrome.declarativeNetRequest.getEnabledRulesets()")
    print("tracker ruleset enabled:", rulesets)
    check(rulesets == ["trackers"], "turning on opt-in 2 switches the tracker rules on")

    print("\n[known platform: OneTrust]")
    ws = goto(ws, "consent-onetrust.html", 6)
    st = cdp.js(ws, """({consent: document.documentElement.dataset.consent || 'none',
        banner: !!document.getElementById('onetrust-banner-sdk'),
        tracker: document.documentElement.dataset.trackerRan || 'blocked'})""")
    print("   ", st)
    check(st["consent"] == "rejected", "clicks Reject All, not Accept or Cookie Settings")
    check(not st["banner"], "the banner is gone because the site removed it, having been answered")
    check(st["tracker"] == "blocked", "a third-party tracker script never runs")

    print("\n[unknown platform inside a shadow root]")
    ws = goto(ws, "consent-shadow.html", 6)
    st = cdp.js(ws, "({consent: document.documentElement.dataset.consent || 'none'})")
    print("   ", st)
    check(st["consent"] == "rejected", "finds the Reject all button through the shadow root, by its words")

    print("\n[no reject on the first screen]")
    ws = goto(ws, "consent-prefs.html", 8)
    st = cdp.js(ws, """(() => { const d = document.documentElement.dataset;
        return {consent: d.consent || 'none', necessary: d.necessary, analytics: d.analytics, ads: d.ads}; })()""")
    print("   ", st)
    check(st["consent"] == "saved", "opens the preferences and saves rather than accepting")
    check(st["analytics"] == "false" and st["ads"] == "false", "every switch that can be turned off is off")
    check(st["necessary"] == "true", "the strictly necessary one, which the site locked on, is left on")

    print("\n[legal]")
    ws = goto(ws, "legal.html", 6)
    st = cdp.js(ws, """(() => {
        const vis = (id) => { const e = document.getElementById(id);
          return !!e && getComputedStyle(e).display !== 'none'; };
        return {passive: vis('passive'), form: vis('signup'), checkbox: vis('agree'),
                label: vis('agree-label'), checked: document.getElementById('agree').checked,
                submit: vis('submit')}; })()""")
    print("   ", st)
    check(not st["passive"], "a passive 'by continuing you accept' notice is removed")
    check(st["form"] and st["checkbox"] and st["label"] and st["submit"],
          "the signup form and its agreement checkbox are untouched")
    check(st["checked"] is False, "and nothing ticked or unticked the checkbox on the person's behalf")

    print("\n[the numbers]")
    time.sleep(2.5)
    raw = open(os.path.expanduser("~/.local/share/omarchy-adblock/stats.json")).read()
    site = json.loads(raw)["sites"].get("site.adtest.example", {})
    print("   ", {k: site.get(k, 0) for k in ("ads", "trackers", "consent", "legal")})
    check(site.get("consent", 0) >= 3, "three consent dialogs declined are counted")
    check(site.get("legal", 0) >= 1, "the removed legal notice is counted")
finally:
    proc.terminate()

print("\nOVERALL:", "PASS" if ok else "FAIL")

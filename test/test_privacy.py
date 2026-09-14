"""Opt-ins 2 and 3: consent is declined, trackers are blocked, legal notices go,
and a form's agreement checkbox is never touched."""
import json, os, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp

S = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(S), "browser", "extension")
PROF = "/tmp/omarchy-adblock-test-privacy"
PORT = 9260
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
    check(sorted(rulesets) == ["gpc", "trackers"],
          "turning on opt-in 2 switches the tracker rules and the GPC header on")

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

    print("\n[US banner with no reject, arriving after every timer: the cnbc.com shape]")
    ws = goto(ws, "consent-onetrust-us.html", 15)
    st = cdp.js(ws, """(() => { const d = document.documentElement.dataset;
        return {consent: d.consent || 'none', necessary: d.necessary, sale: d.sale, targeting: d.targeting,
                banner: !!document.getElementById('onetrust-banner-sdk')}; })()""")
    print("   ", st)
    check(st["consent"] == "saved", "opens Your Privacy Choices and confirms, never Continue")
    check(st.get("sale") == "false" and st.get("targeting") == "false", "sale of data and targeted ads are switched off")
    check(st.get("necessary") == "true" and not st["banner"], "the locked necessary cookies stay, and the banner is gone")

    print("\n[a consent platform's frame with no src, and a French banner]")
    ws = goto(ws, "consent-blankframe.html", 7)
    st = cdp.js(ws, "document.documentElement.dataset.consent || 'none'")
    print("    blank frame:", st)
    check(st == "rejected", "AppConsent's script-written frame is answered with 'Continue without accepting'")
    ws = goto(ws, "consent-fr.html", 6)
    st = cdp.js(ws, "document.documentElement.dataset.consent || 'none'")
    print("    french:", st)
    check(st == "rejected", "a French banner is answered with 'Tout refuser'")

    print("\n[automatic ad removal on too, banner arrives late]")
    cdp.cjs(ws, cdp.isolated_context(ws), "chrome.storage.local.set({mode:'auto'}).then(()=>1)")
    time.sleep(1)
    # A learned rule for the banner itself, the way an older build or opt-in 2
    # being off could have cached one, next to a learned rule for a real ad. On
    # its own host: the worker keeps a visited site's rules in memory.
    cache = os.path.expanduser("~/.local/share/omarchy-adblock/rules/late.adtest.example.json")
    json.dump({"version": 1, "host": "late.adtest.example", "model": "test", "updated": int(time.time()),
               "block": ["#onetrust-banner-sdk", "#learned-ad"],
               "asked": ["#onetrust-banner-sdk", "#learned-ad"]}, open(cache, "w"))
    ws.call("Page.enable")
    ws.call("Page.navigate", {"url": "http://late.adtest.example:8933/consent-late.html"})
    time.sleep(1.5)
    ws = cdp.attach(PORT, match="consent-late.html")
    time.sleep(9)
    before_ads = json.loads(open(os.path.expanduser(
        "~/.local/share/omarchy-adblock/stats.json")).read())["sites"].get("late.adtest.example", {}).get("ads", 0)
    st = cdp.js(ws, """({consent: document.documentElement.dataset.consent || 'none',
        banner: !!document.getElementById('onetrust-banner-sdk')})""")
    print("   ", st)
    check(st["consent"] == "rejected",
          "the consent dialog is answered, not hidden by the ad layer getting there first")
    check(cdp.js(ws, "getComputedStyle(document.getElementById('learned-ad')).display") == "none",
          "a learned ad rule still hides its ad, while a learned rule for the banner is held back")
    time.sleep(2.5)
    after_ads = json.loads(open(os.path.expanduser(
        "~/.local/share/omarchy-adblock/stats.json")).read())["sites"].get("late.adtest.example", {}).get("ads", 0)
    check(after_ads == before_ads, "and a declined dialog is not also counted as an ad")
    cdp.cjs(ws, cdp.isolated_context(ws), "chrome.storage.local.set({mode:'manual'}).then(()=>1)")
    time.sleep(1)

    print("\n[legal]")
    ws = goto(ws, "legal.html", 6)
    st = cdp.js(ws, """(() => {
        const vis = (id) => { const e = document.getElementById(id);
          return !!e && getComputedStyle(e).display !== 'none'; };
        return {passive: vis('passive'), form: vis('signup'), checkbox: vis('agree'),
                label: vis('agree-label'), checked: document.getElementById('agree').checked,
                submit: vis('submit'), footer: vis('sitefooter')}; })()""")
    print("   ", st)
    check(not st["passive"], "a passive 'by continuing you accept' notice is removed")
    check(st["form"] and st["checkbox"] and st["label"] and st["submit"],
          "the signup form and its agreement checkbox are untouched")
    check(st["footer"], "the site's own sticky footer of legal links stays")
    check(st["checked"] is False, "and nothing ticked or unticked the checkbox on the person's behalf")

    print("\n[legal modal that freezes the page, the cnn.com shape]")
    ws = goto(ws, "legal-lock.html", 7)
    st = cdp.js(ws, """(() => {
        const m = document.getElementById('legalmodal');
        const shown = !!m && getComputedStyle(m).display !== 'none' &&
          getComputedStyle(document.getElementById('legalpanel')).display !== 'none';
        const restored = scrollY;
        scrollTo(0, 2000);
        return {shown, restored, scrolled: scrollY, agreed: document.documentElement.dataset.agreed || 'no',
                bodyPosition: getComputedStyle(document.body).position}; })()""")
    print("   ", st)
    check(not st["shown"], "the legal modal is removed")
    check(st["agreed"] == "no", "and Agree was never clicked")
    check(st["scrolled"] == 2000 and st["bodyPosition"] != "fixed",
          "the page scrolls again, even after the site re-applied its lock")
    check(st["restored"] == 600, "and it is back where the site froze it")

    print("\n[Global Privacy Control]")
    st = cdp.js(ws, "navigator.globalPrivacyControl")
    hdr = cdp.ajs(ws, "fetch('/gpc').then(r => r.text())")
    print("    navigator:", st, " header:", hdr)
    check(st is True, "pages that ask navigator.globalPrivacyControl are told yes")
    check(hdr == "1", "and every request carries Sec-GPC: 1")
    cdp.cjs(ws, cdp.isolated_context(ws), "chrome.storage.local.set({cookies:false}).then(()=>1)")
    time.sleep(1.5)
    ws = goto(ws, "legal-lock.html", 1)
    st = cdp.js(ws, "navigator.globalPrivacyControl")
    hdr = cdp.ajs(ws, "fetch('/gpc').then(r => r.text())")
    print("    opt-in 2 off -> navigator:", st, " header:", hdr)
    check(st is not True and hdr == "none", "and with opt-in 2 off, neither is sent")
    cdp.cjs(ws, cdp.isolated_context(ws), "chrome.storage.local.set({cookies:true}).then(()=>1)")
    time.sleep(1.5)

    print("\n[a site that keeps putting its notice back]")
    before = json.loads(open(os.path.expanduser("~/.local/share/omarchy-adblock/stats.json")).read())["sites"].get("site.adtest.example", {}).get("legal", 0)
    ws = goto(ws, "legal-loop.html", 10)
    inserts = cdp.js(ws, "window.__inserts")
    time.sleep(3)
    inserts2 = cdp.js(ws, "window.__inserts")
    time.sleep(2.5)
    after = json.loads(open(os.path.expanduser("~/.local/share/omarchy-adblock/stats.json")).read())["sites"].get("site.adtest.example", {}).get("legal", 0)
    print("    inserts:", inserts, "->", inserts2, "| legal counted:", after - before)
    check(after - before <= 1, "the same notice put back again and again is counted once")
    check(inserts <= 8 and inserts2 == inserts, "and after a few returns it is left alone instead of fought forever")

    print("\n[the numbers]")
    time.sleep(2.5)
    raw = open(os.path.expanduser("~/.local/share/omarchy-adblock/stats.json")).read()
    site = json.loads(raw)["sites"].get("site.adtest.example", {})
    print("   ", {k: site.get(k, 0) for k in ("ads", "trackers", "consent", "legal")})
    check(site.get("consent", 0) >= 4, "four consent dialogs declined are counted")
    check(site.get("legal", 0) >= 1, "the removed legal notice is counted")
finally:
    proc.terminate()

print("\nOVERALL:", "PASS" if ok else "FAIL")

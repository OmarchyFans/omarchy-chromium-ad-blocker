"""Smoke test against live news sites. Not part of the regular suite: it needs
the network, and the sites change daily.

    python3 test/smoke_news.py                 # every site in SITES
    python3 test/smoke_news.py statesman bbc   # only sites whose URL contains these
    SMOKE_OFF=1 python3 test/smoke_news.py     # same run without the extension

Each site loads in its own headless Chromium with automatic removal and both
privacy opt-ins on, in a throwaway HOME so the real statistics and rule cache
are untouched. For each it records whether the mouse wheel scrolls the page,
how busy the main thread is while scrolling, what is still stacked over the
page (offers, consent, overlays), whether html/body are still locked or
blurred, and whether a bot check answered instead of the site. Results go to
test/smoke-out/<run>/results.json with a screenshot per site.
"""
import base64, concurrent.futures, json, os, re, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp

S = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(S), "browser", "extension")
RUN = time.strftime("%Y%m%d-%H%M%S")
OUT = os.path.join(S, "smoke-out", RUN)
OFF = os.environ.get("SMOKE_OFF") == "1"
PARALLEL = int(os.environ.get("SMOKE_PARALLEL", "4"))

SITES = [
    # United States
    "https://www.statesman.com/news/healthcare/article/texas-primary-care-doctor-shortage-22412689.php",
    "https://www.nytimes.com/", "https://www.washingtonpost.com/", "https://www.usatoday.com/",
    "https://www.cnn.com/", "https://www.foxnews.com/", "https://www.nbcnews.com/", "https://www.cbsnews.com/",
    "https://abcnews.go.com/", "https://www.npr.org/", "https://apnews.com/", "https://www.reuters.com/",
    "https://www.latimes.com/", "https://www.chicagotribune.com/", "https://www.bostonglobe.com/",
    "https://www.sfchronicle.com/", "https://www.houstonchronicle.com/", "https://www.politico.com/",
    "https://thehill.com/", "https://www.axios.com/", "https://www.newsweek.com/", "https://www.forbes.com/",
    "https://www.businessinsider.com/", "https://www.cnbc.com/", "https://www.huffpost.com/",
    "https://nypost.com/", "https://www.miamiherald.com/", "https://www.seattletimes.com/",
    "https://www.denverpost.com/", "https://www.dallasnews.com/",
    # Rest of the world
    "https://www.bbc.com/news", "https://www.theguardian.com/international", "https://www.dailymail.co.uk/",
    "https://www.independent.co.uk/", "https://www.telegraph.co.uk/", "https://www.spiegel.de/",
    "https://www.bild.de/", "https://www.lemonde.fr/", "https://www.lefigaro.fr/", "https://elpais.com/",
    "https://www.corriere.it/", "https://www.repubblica.it/", "https://nos.nl/", "https://www.aljazeera.com/",
    "https://timesofindia.indiatimes.com/", "https://www.hindustantimes.com/", "https://www.scmp.com/",
    "https://www.abc.net.au/news", "https://www.smh.com.au/", "https://www.cbc.ca/news",
    "https://www.theglobeandmail.com/", "https://www.japantimes.co.jp/", "https://www.lanacion.com.ar/",
    "https://www1.folha.uol.com.br/", "https://www.news24.com/", "https://www.straitstimes.com/",
    "https://www.nzherald.co.nz/", "https://www.irishtimes.com/", "https://www.thelocal.se/",
]

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"

PROBE = r"""(() => {
  const vw = innerWidth * innerHeight;
  const OFFER = /\b(subscribe|subscription|sign up|log in to|register|free trial|unlimited (digital )?access|per (month|week)|\$\d|special offer|limited time|already a subscriber|turn off your ad ?blocker|disable your ad ?blocker|newsletter|get the app|continue reading)\b/i;
  const CONSENT = /\b(cookies?|consent|gdpr|ccpa|privacy (choices|preferences|settings)|your privacy|partners|legitimate interest|accept all|reject all|agree)\b/i;
  const overlays = [];
  const walk = (root) => { for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) walk(el.shadowRoot);
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 30 || r.bottom <= 0 || r.top >= innerHeight) continue;
    const cover = (Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * (Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) / vw;
    if (cover < 0.02) continue;
    if (el.closest('header, nav, [role=banner], [role=navigation]')) continue;
    // A header wrapper counts only through what is not the header inside it.
    const holdsNav = !!el.querySelector('header, nav, [role=banner], [role=navigation]');
    const text = (holdsNav ? [...el.querySelectorAll('div,section,aside,p')].filter(c => !c.closest('header,nav,[role=banner],[role=navigation]') && !c.querySelector('header,nav,[role=banner],[role=navigation]') && getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().height > 30).map(c => c.innerText).join(' ') : (el.innerText || '')).replace(/\s+/g, ' ').trim();
    const frames = [...el.querySelectorAll('iframe')].map(f => (f.src || '').slice(0, 80));
    const kind = CONSENT.test(text) ? 'consent' : OFFER.test(text) ? 'offer' : cover > 0.3 ? 'overlay' : frames.length ? 'frame' : '';
    if (!kind) continue;
    if (overlays.some(o => o.el.contains(el))) continue;
    for (let i = overlays.length - 1; i >= 0; i--) if (el.contains(overlays[i].el)) overlays.splice(i, 1);
    overlays.push({el, kind, tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className || '').slice(0, 60),
      z: cs.zIndex, cover: +cover.toFixed(2), frames, text: text.slice(0, 140),
      marked: el.hasAttribute('data-omarchy-ad')});
  }};
  walk(document);
  const H = document.documentElement, B = document.body, hc = getComputedStyle(H), bc = getComputedStyle(B || H);
  const blurred = [H, B, ...(B ? B.children : [])].filter(e => e && /blur\(/.test(getComputedStyle(e).filter)).length;
  const t = (document.title || '') + ' ' + (B ? B.innerText.slice(0, 400) : '');
  return {
    title: document.title.slice(0, 80),
    botCheck: /just a moment|verify you are human|verification required|access denied|access issue|unusual activity|are you a robot|attention required|pardon our interruption|unusual traffic|press & hold/i.test(t),
    overlays: overlays.map(({el, ...o}) => o),
    locked: {html: [hc.overflow, hc.position], body: [bc.overflow, bc.position]},
    blurred,
    marked: document.querySelectorAll('[data-omarchy-ad]').length,
    learnedRules: ((document.getElementById('omarchy-adblock-style') || {}).textContent || '').split('\n').filter(Boolean).length,
    docHeight: H.scrollHeight,
  };
})()"""


def metrics(ws):
    return {m["name"]: m["value"] for m in ws.call("Performance.getMetrics")["metrics"]}


def run_site(i, url):
    port = 9500 + i
    name = re.sub(r"^https?://(www1?\.)?", "", url).split("/")[0]
    prof = f"/tmp/omarchy-smoke-{RUN}-{i}"
    home = f"{prof}-home"
    for d in (prof, home):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs(f"{prof}/NativeMessagingHosts")
    os.makedirs(f"{home}/.config/omarchy-adblock")
    real_cfg = os.path.expanduser("~/.config/omarchy-adblock/config.json")
    if os.path.exists(real_cfg):
        shutil.copy(real_cfg, f"{home}/.config/omarchy-adblock/")
    shutil.copy(os.path.expanduser("~/.config/chromium/NativeMessagingHosts/com.omarchy.adblock.json"),
                f"{prof}/NativeMessagingHosts/")
    args = ["/usr/lib/chromium/chromium", "--headless=new", "--disable-gpu", "--no-first-run",
            f"--user-data-dir={prof}", f"--remote-debugging-port={port}", "--window-size=1440,900",
            f"--user-agent={UA}", "--mute-audio", "--autoplay-policy=user-gesture-required"]
    if not OFF:
        args += [f"--load-extension={EXT}", f"--disable-extensions-except={EXT}"]
    env = dict(os.environ, HOME=home)
    proc = subprocess.Popen(args + ["about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    res = {"url": url, "name": name}
    try:
        ws = cdp.attach(port, match="about:blank")
        if not OFF:
            sw = cdp.attach_type(port, "service_worker")
            cdp.ajs(sw, "chrome.storage.local.set({enabled:true, mode:'auto', ai:true, cookies:true, legal:true}).then(()=>1)")
            time.sleep(1.5)
        ws.call("Page.enable")
        t0 = time.time()
        ws.call("Page.navigate", {"url": url})
        ws.drain(16)
        ws = cdp.attach(port, match="http")  # the one page, wherever it redirected
        ws.call("Performance.enable")
        res["before"] = cdp.js(ws, PROBE)
        # Scroll with the wheel, the way a person would, and time it.
        w, h = 720, 450
        a = metrics(ws); s0 = time.time(); ys = []; lat = []
        for _ in range(10):
            t = time.time()
            ws.call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": w, "y": h, "deltaX": 0, "deltaY": 500})
            lat.append(int((time.time() - t) * 1000))
            ws.drain(0.45)
            ys.append(int(cdp.js(ws, "scrollY") or 0))
        b = metrics(ws); dt = time.time() - s0
        if ys[-1] <= 400:
            # A carousel or widget under the pointer can take the wheel; try the edge.
            for _ in range(4):
                ws.call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": 8, "y": h, "deltaX": 0, "deltaY": 500})
                ws.drain(0.45)
                ys.append(int(cdp.js(ws, "scrollY") or 0))
        res["scroll"] = {"ys": ys, "maxLatencyMs": max(lat), "moved": ys[-1] > 400,
                         "busyPct": round(100 * (b["TaskDuration"] - a["TaskDuration"]) / dt),
                         "scriptPct": round(100 * (b["ScriptDuration"] - a["ScriptDuration"]) / dt),
                         "layoutPct": round(100 * (b["LayoutDuration"] + b["RecalcStyleDuration"] - a["LayoutDuration"] - a["RecalcStyleDuration"]) / dt)}
        ws.drain(3)
        res["after"] = cdp.js(ws, PROBE)
        png = ws.call("Page.captureScreenshot", {"format": "png"})["data"]
        with open(os.path.join(OUT, f"{i:02d}-{name}.png"), "wb") as fh:
            fh.write(base64.b64decode(png))
        try:
            stats = json.load(open(f"{home}/.local/share/omarchy-adblock/stats.json"))
            res["stats"] = stats["totals"]
        except Exception:
            res["stats"] = None
        res["seconds"] = round(time.time() - t0)
    except Exception as e:
        res["error"] = f"{type(e).__name__}: {str(e)[:200]}"
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except Exception:
            proc.kill()
        shutil.rmtree(prof, ignore_errors=True)
        shutil.rmtree(home, ignore_errors=True)
    return res


def verdict(r):
    if r.get("error"):
        return "ERROR"
    after = r["after"]
    if after["botCheck"]:
        return "BOT-CHECK"
    problems = []
    if not r["scroll"]["moved"]:
        problems.append("no-scroll")
    if r["scroll"]["busyPct"] > 60 or r["scroll"]["maxLatencyMs"] > 800:
        problems.append(f"slow(busy {r['scroll']['busyPct']}%, {r['scroll']['maxLatencyMs']}ms)")
    for o in after["overlays"]:
        if o["kind"] in ("consent", "offer") or o["cover"] > 0.3:
            problems.append(f"{o['kind']}:{o['cover']}:{(o['id'] or o['cls'])[:30]}")
    if after["locked"]["html"][0] in ("hidden", "clip") or after["locked"]["body"][0] in ("hidden", "clip") \
            or "fixed" in (after["locked"]["html"][1], after["locked"]["body"][1]):
        problems.append(f"locked{after['locked']}")
    if after["blurred"]:
        problems.append("blurred")
    return "OK" if not problems else "; ".join(problems)


def main():
    picks = [s for s in SITES if not sys.argv[1:] or any(k in s for k in sys.argv[1:])]
    os.makedirs(OUT, exist_ok=True)
    results = []
    with concurrent.futures.ThreadPoolExecutor(PARALLEL) as pool:
        futs = {pool.submit(run_site, i, u): u for i, u in enumerate(picks)}
        for f in concurrent.futures.as_completed(futs):
            r = f.result()
            r["verdict"] = verdict(r)
            results.append(r)
            print(f"{r['name']:32} {r['verdict']}", flush=True)
    results.sort(key=lambda r: r["name"])
    with open(os.path.join(OUT, "results.json"), "w") as fh:
        json.dump(results, fh, indent=1)
    ok = sum(r["verdict"] == "OK" for r in results)
    print(f"\n{ok}/{len(results)} OK · {'extension OFF' if OFF else 'extension ON'} · {OUT}")


if __name__ == "__main__":
    main()

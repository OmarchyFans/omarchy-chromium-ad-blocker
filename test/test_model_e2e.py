"""The last unproven link: browser -> host -> local GPU -> cached rule.

The test server is on loopback, and the host refuses to describe a loopback host
to any model — correctly. So Chromium is told to resolve a non-private name to
127.0.0.1 instead, which is what a real site looks like from the host's side.
"""
import json, os, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp

S = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(S), "extension")
PROF = "/tmp/omarchy-adblock-test-test_model_e2e"
HOSTNAME = "adtest.example"
CACHE = os.path.expanduser(f"~/.local/share/omarchy-adblock/rules/{HOSTNAME}.json")
LOG = os.path.expanduser("~/.local/share/omarchy-adblock/host.log")
for f in (CACHE, LOG):
    if os.path.exists(f): os.remove(f)
shutil.rmtree(PROF, ignore_errors=True)
os.makedirs(f"{PROF}/NativeMessagingHosts", exist_ok=True)
shutil.copy(os.path.expanduser("~/.config/chromium/NativeMessagingHosts/com.omarchy.adblock.json"),
            f"{PROF}/NativeMessagingHosts/")

proc = subprocess.Popen([
    "chromium", "--headless=new", "--no-sandbox", "--disable-gpu",
    f"--user-data-dir={PROF}", f"--load-extension={EXT}",
    f"--disable-extensions-except={EXT}",
    f"--host-resolver-rules=MAP {HOSTNAME} 127.0.0.1",
    "--remote-debugging-port=9240", "--window-size=1280,900",
    f"http://{HOSTNAME}:8933/page.html",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ok = True
def check(c, m):
    global ok
    print(("  PASS  " if c else "  FAIL  ") + m); ok = ok and c

try:
    ws = cdp.attach(9240, match="page.html")
    print("page:", cdp.js(ws, "location.host"))
    # the model pass is a background round trip; give the GPU its 5-6 seconds
    time.sleep(22)
    st = cdp.js(ws, "window.__state()")
    print(f"\nmarked={st['marked']}  rail={st['rail']}")

    print("\n[what the local GPU decided]")
    if os.path.exists(CACHE):
        d = json.load(open(CACHE))
        print("  blocked  :", d["block"])
        print("  ruled on :", d["asked"])
        print("  endpoint :", d["model"])
        check(True, "the browser reached the local GPU and the verdict was cached")
        check("#rail" in d["asked"], "the ambiguous ad rail was the thing it was asked about")
        check(not any(s in ("body", "#login", "#nav") for s in d["block"]),
              "it did not return the navigation or the password form")
    else:
        check(False, "the browser reached the local GPU (no cache file written)")

    # second load must not ask again
    before = os.path.getmtime(CACHE) if os.path.exists(CACHE) else 0
    ws.call("Page.enable"); ws.call("Page.reload", {"ignoreCache": True})
    time.sleep(2); ws = cdp.attach(9240, match="page.html"); time.sleep(14)
    after = os.path.getmtime(CACHE) if os.path.exists(CACHE) else 0
    check(before == after, "a second visit uses the cache instead of asking again")
finally:
    proc.terminate(); time.sleep(1)

print("\n[host log]")
print("  " + (open(LOG).read().strip() or "(clean)") if os.path.exists(LOG) else "  (clean)")
print("\nOVERALL:", "PASS" if ok else "FAIL")

# Tests

These drive a real headless Chromium over the DevTools protocol, so the
keystrokes and clicks are **trusted** events — the same thing a person's
keyboard produces. A synthetic `KeyboardEvent` would only prove the listener
runs; this proves the chord works.

`cdp.py` is a ~150-line CCDP client with no third-party packages: a WebSocket
implementation, `Runtime.evaluate` in both the page's world and the content
script's isolated world, and `Input.dispatchKeyEvent` / `dispatchMouseEvent`.

```bash
python3 test/serve.py &          # instrumented page on 127.0.0.1:8933
python3 test/test_manual.py      # manual mode + the chord      (12 checks)
python3 test/test_auto_pick.py   # auto mode                     (4 checks)
python3 test/test_picker.py      # the click picker             (11 checks)
python3 test/test_durable.py     # a hand-marked ad, next visit   (5 checks)
python3 test/test_model_e2e.py   # browser -> host -> local GPU   (4 checks)
```

`test_model_e2e.py` needs a model answering on `local_endpoint`. It also has to
lie to Chromium: the test server is on loopback, and the host refuses to describe
a loopback host to any model, so `--host-resolver-rules` maps a non-private name
to 127.0.0.1. Without that, the model pass is never reached and the other tests
exercise only the first two layers.

Each launches its own Chromium with its own profile and debugging port, and
copies the installed native-host manifest into it, so `./install.sh` must have
run first.

`page.html` carries one of everything worth getting right: a fullscreen cookie
wall, an edge newsletter bar, a paywall modal revealed on a timer two seconds in,
a sticky ad rail, a static `adsbygoogle` slot, a sponsored box — and, as the
things that must survive, site navigation, a password form and the article.

# omarchy-chromium-ad-blocker

Filter lists go stale the week they ship. This reads the page instead, on a
model running on your own GPU, and never has to phone anyone to do it.

Three opt-ins, each independent:

| | Default | What it does |
|---|---|---|
| **1. Block ads** | on, asks first | Ads, popups and overlays. Hold **Ctrl+Alt** to see them, **Delete** to remove them, or turn on automatic removal. |
| **2. Block tracking cookies** | off | Declines consent dialogs, sends Global Privacy Control, blocks third-party trackers, clears tracker cookies. |
| **3. Block legal popups** | off | Declines terms and privacy prompts that can be declined, and removes notices that offer no choice. |

The popup shows what each has removed, for the current site and for all time.

## 1 · Block ads

| | |
|---|---|
| **Hold, look, delete** | Hold **Ctrl+Alt**. The page zooms out and every ad it found is outlined in red, with a count. **Delete** removes them. Let go instead and nothing happened. |
| **Point at one** | Press **P** during the chord, or *Pick one* in the popup. Click an ad and it goes, and it becomes a permanent note about that site in your own hand. |
| **Never ask again** | Turn on automatic removal and ads go as each page loads, before they paint. |

## 2 · Block tracking cookies

It answers consent dialogs rather than hiding them. A hidden cookie wall leaves
the site with no answer, and many then assume consent or ask again on the next
page. Answering "no" is what actually stops it.

- **Known consent platforms** are recognised by the buttons they ship: OneTrust,
  Cookiebot, Didomi, Quantcast, Usercentrics, Osano, CookieYes, Termly,
  Complianz, Klaro, Iubenda, Sourcepoint, TrustArc, Borlabs, CookieFirst and
  Axeptio.
- **Anything else** is found by its button text, including dialogs inside shadow
  roots and cross-origin iframes. The local model is asked only when the words
  do not settle it, and any pick that reads as "accept" is refused whatever the
  model thought.
- **No reject button on the first screen?** It opens the preferences, switches
  off every control the site lets you switch off, and saves. Controls the site
  has locked on are the strictly necessary ones, so they stay on.
- **Global Privacy Control** is sent on every request (`Sec-GPC: 1`) and
  answered to scripts that ask (`navigator.globalPrivacyControl`). It is the
  legal "do not sell or share my data" signal, and consent platforms record it.
  On cnn.com, OneTrust sets its sale, sharing and personalised-ads groups on
  without it, and off with it.
- **68 third-party tracker hosts** are blocked at the network level: analytics,
  ad exchanges, social pixels, video beacons. Third-party only, so a site
  measuring its own pages keeps working. A blocked request is counted once per
  page, however often the page retries it.
- **Tracker cookies are cleared by name** (`_ga`, `_fbp`, `_hj*` and so on),
  never every cookie for a site, which would sign you out.
- **Blocking every third-party cookie** is a separate switch, off even when this
  is on. It changes a browser-wide setting and breaks some "sign in with Google"
  and embedded payment flows. Chromium hands the setting back if the extension
  is removed.

Blocked trackers are counted as they happen. Chromium only offers that event
to unpacked extensions, which is how this installs; a packed copy falls back to
checking once a minute, the most its rate limit allows.

With automatic ad removal also on, a consent dialog gets six seconds to be
answered before the ad layer may hide it. Hiding it first would leave the site
with no answer, and it would ask again on the next page.

A click from an extension is not a trusted event. Most consent platforms accept
it; a few check, and will ignore it. When that happens, opt-in 1 can still hide
the dialog.

## 3 · Block legal popups

It declines what can be declined and removes notices that offer no choice, like
"by continuing you accept our terms" with only an OK.

It never removes an agreement checkbox from a form you are submitting. Hiding
that checkbox hides the terms without unbinding you from them: the site binds
you when you submit either way. Nothing inside a form is touched, by any opt-in.

A legal modal with only an **Agree** button, like cnn.com's, is removed without
clicking it. Sites freeze the page behind such a modal, so the lock goes too and
the page scrolls again from where it was, even if the site re-applies it. No
agreement is given, and no "agreed" cookie is forged: a forged one would tell
the site's trackers they may run. Turn on opt-in 2 as well so the site also
receives Global Privacy Control.

## Private browsing

```bash
omarchy-adblock private on
```

Chromium opens in incognito from its next start, and your history is kept in
`~/.local/share/omarchy-adblock/history.jsonl` (readable only by you) instead of
nowhere. `omarchy-adblock history github` searches it.

**Until you do one more step, nothing is blocked at all**, and the toolbar button
does not appear: every window is now incognito, and Chromium refuses to let a
program grant an extension incognito access. Open `chrome://extensions`, then
Details on this extension, and turn on **Allow in Incognito**.

Incognito keeps no logins between sessions. That is the point, and why this is
off unless you turn it on.

## Statistics

Counted when something is actually removed, not when it is detected, so manual
mode adds nothing until you press Delete.

```bash
omarchy-adblock stats              # all time, plus the busiest sites
omarchy-adblock stats nytimes.com  # one site
```

## How it decides

Three layers, cheapest first. Nothing waits on the layer behind it.

| Layer | Catches | Cost |
|---|---|---|
| **Static rules** | Known ad slots, `adsbygoogle`, Taboola, doubleclick iframes | none |
| **DOM heuristics** | Cookie walls, newsletter modals, notification nags, scroll locks | none |
| **The model** | Whatever the first two were unsure about | one pass per site, ever |

That last row is literal: the model is not asked again about anything this site
has already been ruled on, and it is not asked at all until the site's history
has come back from disk.

The third layer runs least. A site is classified once; the verdicts are written
to `~/.local/share/omarchy-adblock/rules/<host>.json` and mirrored into
extension storage, so on every later visit the rules apply before the page
paints, with no round trip.

Both halves of the answer are kept. "That sticky bar is an ad" becomes a rule;
"that sticky bar is your nav" is remembered too, so a site with one legitimate
fixed header does not cost a pass on every page load.

## Install

```bash
git clone https://github.com/OmarchyFans/omarchy-chromium-ad-blocker.git
cd omarchy-chromium-ad-blocker
./install.sh
omarchy-adblock restart
```

The default install adds **no Python packages**. The local backend speaks
OpenAI-compatible HTTP from the standard library.

`install.sh` is idempotent and safe to re-run. It derives the extension ID from
the public key pinned in `manifest.json`, adds the extension to the *existing*
`--load-extension=` line in `~/.config/chromium-flags.conf` (Chromium honours
only the last such flag, so appending a second would silently unload Omarchy's
own extensions), registers the native messaging host for Chromium, Chrome, Brave
and Edge, and installs a `post-update.d` hook that re-applies both after an
Omarchy update rewrites the flags file.

Restart Chromium **completely** afterwards. A new window is not enough: the
flags and the host manifest are only read at browser startup.

`./uninstall.sh` reverses everything; add `--purge` to drop the learned rules too.

## The model

Any OpenAI-compatible server: llama.cpp's `llama-server`, ollama, vLLM. Omarchy's
own local agent serves one, and so does
[omarchy-fans-help](https://github.com/OmarchyFans/omarchy-fans-help).

```bash
omarchy-adblock endpoint http://127.0.0.1:8080   # where it listens
omarchy-adblock status                           # is anything answering?
```

If nothing is, the first two layers still work and already handle most cookie
walls. The installer says so rather than leaving you guessing.

It was built and measured against a 4B model (`Qwen3.8-4B-Distill-Q4_K_M`) fully
offloaded to a 4&nbsp;GB laptop GPU. That is enough, because the job is a small
classification over a couple of dozen short structural records rather than a
conversation. Two findings worth keeping if you swap the model out:

- **A JSON schema, not a JSON request.** `response_format: json_object` asks
  nicely and a 4B model replies `No ads found.` in prose. A schema constrains
  generation itself, so the reply parses or the server rejects the request.
- **Leave thinking on.** Off, it answers in 1.1s, catches one ad in three, and
  invents a selector it was never shown. On, it takes 4-6s and catches all three
  without touching a checkout form. That is paid once per site.

No GPU at all? `./install.sh --with-anthropic` and
`omarchy-adblock backend anthropic` uses the Claude API instead
(`claude-haiku-4-5` by default). The request adapts to the model: `effort` is
rejected outright by Haiku 4.5, and the server-side refusal fallback only exists
on models that can refuse.

## What leaves your machine

Nothing, on the default backend. On either backend:

- **Page content is never sent.** The model sees a structural description of at
  most 25 candidate elements: tag, id, class names, CSS position, z-index, size,
  share of the viewport, counts of links/inputs/iframes, and at most **120
  characters** of text per element, which is what distinguishes "We use cookies"
  from a nav bar.
- **Most pages send nothing.** The first two layers resolve the common cases,
  and a site classified once never asks again.
- Private networks are excluded in the host itself: loopback, RFC1918
  addresses, single-label names like `nas`, and `.local` / `.lan` / `.internal` /
  `.home.arpa`.
- Sites in the popup's allowlist are skipped before any layer runs.

## It refuses to break the page

- The model may only return selectors it was **shown**. An invented one is dropped.
- Page-blanking selectors (`body`, `div`, `*`, `main`, …) are rejected outright.
- Only selectors matching exactly one element are cached. A positional one
  (`:nth-child(4)`) hides something now but is never stored, because it means a
  different element on the next page.
- Cached rules are re-checked against the live DOM as they arrive. One covering
  a login form is withdrawn and the site re-learned; one matching a suspicious
  number of elements is skipped on that page only.
- Anything wrapping a `password` or card field is never hidden, at any layer.
- Known app hosts (Google Docs, Figma, Slack, GitHub, YouTube …) skip the
  heuristics entirely, because there an overlay is usually the app.
- Removing a modal releases the scroll lock it left on `<body>`. A page that
  cannot scroll reads as a worse bug than the popup did.
- Prompt injection in element text moved neither the model nor the filters when
  tested.

## The chord

**Ctrl+Alt** to preview, **Delete** to commit, **P** to pick one by hand, **Esc**
or releasing either modifier to cancel. Delete only, not Backspace: Ctrl+Alt+
Backspace is the kill-the-session chord on some setups. It is clear of everything that matters:
Chromium keeps Ctrl+Shift+Delete for clearing browsing data and the page never
sees it, Alt+Shift is a keyboard-layout toggle on many setups, and every Omarchy
Hyprland binding leads with SUPER.

Holding the chord freezes the set after one final scan, so a popup that appeared
a moment ago is included in what you are about to delete. The scroll position is
saved and restored around the zoom.

## Commands

```bash
omarchy-adblock status                    # what is installed, configured, learned
omarchy-adblock mode auto                 # or manual
omarchy-adblock sites                     # sites with learned rules
omarchy-adblock show nytimes.com          # what it learned, and what you marked
omarchy-adblock marked                    # just the ads you marked by hand
omarchy-adblock forget nytimes.com        # re-learn a site (keeps your own marks)
omarchy-adblock unmark nytimes.com        # drop what you marked by hand
omarchy-adblock log                       # why the model pass went quiet
omarchy-adblock stats [host]              # what has been removed
omarchy-adblock private on|off            # incognito, with history kept here
omarchy-adblock history [search]          # that history
```

Chromium discards a native host's stderr, so failures in the model pass would
otherwise be invisible. They go to `~/.local/share/omarchy-adblock/host.log`, and
the most recent one shows in both `status` and the popup.

## What "mark" means

Marking and removing are separate. Every layer marks; a commit step removes. In
manual mode nothing is removed until you press the chord — including rules
learned earlier and ads you marked by hand. Those are durable *labels*; when
they get deleted is what the mode decides. Turn on automatic mode if you would
rather a site you have already judged never show you its ads again.

## How it fits into Omarchy

`omarchy plugin add` installs Quickshell shell plugins: bar widgets, panels,
overlays. A browser extension is not one of those, so this ships as its own repo
following Omarchy's conventions instead of its plugin registry — the same
native-messaging-host pattern as `omarchy-chromium-ytdlp`, the same
`omarchy:summary=` script headers, and a `post-update.d` hook so an Omarchy
update does not quietly unwire it.

## Layout

```
extension/     MV3 extension — layers, chord, picker, popup
host/          native messaging host: rule cache on disk, the model call
bin/           the omarchy-adblock CLI
install.sh     idempotent installer; uninstall.sh reverses it
```

MIT.

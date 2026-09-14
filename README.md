# Chromium Ad Blocker for Omarchy

An Omarchy plugin that cleans up the web in Chromium. It removes ads, popups and
sales offers, says no to tracking-cookie dialogs, blocks trackers, and clears
legal popups without agreeing to anything. Filter lists go stale the week they
ship, so this reads the page instead: fast rules and page heuristics act
instantly, and an optional model on your own GPU classifies the rest without
sending the page anywhere.

## Features

- **Removes ads and popups.** Ad slots, sticky rails, newsletter walls, "turn
  off your ad blocker" overlays, and sales offers like "unlimited access for
  $1/month", including offers drawn inside frames the page cannot read.
- **Hold, look, delete.** Hold **Ctrl+Alt** to zoom out and see every ad
  outlined, press **Delete** to remove them all, or turn on automatic removal.
- **Click to remove.** Point at anything the blocker missed; it goes, and it is
  remembered for that site.
- **Clean chosen sites automatically.** Tick "Clean this site automatically" in
  the popup and that site is cleaned on every visit, while automatic removal
  stays off everywhere else. Every setting applies to the open page at once,
  with no reload.
- **Declines cookie consent for you.** Presses Reject on OneTrust, Cookiebot,
  Didomi, Quantcast, Usercentrics, Sourcepoint, TrustArc and more. With no
  reject button, it opens the privacy choices, switches everything off that can
  be, and saves, never "Accept" or "Continue".
- **Blocks trackers and sends Global Privacy Control.** 68 third-party tracker
  hosts are blocked, tracker cookies are cleared by name, and every site gets
  the legal "do not sell or share my data" signal.
- **Clears legal popups without agreeing.** "Agree to continue" modals, like
  cnn.com's, are removed and the page scrolls again. Agreement checkboxes in
  forms you fill in are never touched.
- **Never breaks the page.** Site headers and navigation, login and payment
  fields, and bot checks such as DataDome or Cloudflare are never hidden. A
  removed popup's scroll lock, blur and leftover backdrop go with it, and the
  page keeps scrolling when the pointer is over an embedded player.
- **Tested on real news sites.** `test/smoke_news.py` loads 59 US and world
  news sites and checks scrolling, load, and anything still stacked over the
  page. Consent wording is understood in English, French, German, Spanish,
  Italian, Dutch, Portuguese and Swedish.
- **Private browsing with local history.** Always open Chromium in incognito,
  with the blocker running there and your history kept on your own disk.
- **Statistics.** Ads, trackers, consent dialogs and legal notices removed, per
  site and in total, in the extension popup, a bar button and the terminal.
- **Local first.** The model runs on your GPU through any OpenAI-compatible
  server. Anthropic's Claude Haiku is an opt-in alternative for machines
  without one.

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

Popups count as ads: newsletter walls, "turn off your ad blocker", and sales
offers. An offer is recognised by its pitch ("unlimited digital access for
$1/month", "start your free trial", "get the app") or, when the pitch lives in a
frame the page cannot read, by the frame's address: overlay services, paywalls
and offer platforms. The site's own header and navigation are never removed,
even with a promo strip in them.

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
  has locked on are the strictly necessary ones, so they stay on. That includes
  US banners whose only other button is "Continue": on cnbc.com it opens "Your
  Privacy Choices", turns off sale and sharing, and confirms.
- **Late banners are still answered.** A banner that arrives after a slow
  geolocation lookup gets the same treatment, however long after load.
- **An ad rule never hides a consent banner.** With this opt-in on, a rule the
  model learned for a site is held back from the site's consent platform, so the
  banner stays up long enough to be declined.
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

The blocker only runs in incognito windows once it has **Allow in Incognito**.
Without it nothing is blocked there, the toolbar button does not appear, and no
history is kept, because the extension never sees the pages. An extension
cannot grant itself that, so `private on` sets it for every Chromium profile
that has loaded the blocker. Chromium rewrites that setting when it exits, so
the command closes Chromium and reopens it. To change only this:

```bash
omarchy-adblock incognito        # on or off, per profile
omarchy-adblock incognito on     # closes and reopens Chromium
```

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

As an Omarchy plugin, with a bar button that shows what has been removed:

```bash
omarchy plugin add https://github.com/OmarchyFans/omarchy-chromium-ad-blocker --enable
cd ~/.config/omarchy/plugins/fans.omarchy.chromium-ad-blocker
./install.sh
bin/omarchy-adblock restart
```

`omarchy plugin add` installs only the bar button. `install.sh` wires up the
blocker itself, and asks before each change to something that is yours:

| Asked first | What it does |
|---|---|
| **Chromium's startup flags** | Adds the extension to the *existing* `--load-extension=` line in `~/.config/chromium-flags.conf`, after a timestamped backup. Chromium honours only the last such flag, so appending a second would silently unload Omarchy's own extensions. Say no and it prints how to load the extension by hand. |
| **Update hook** | A `post-update.d` hook that re-applies only that flag and the native host after an Omarchy update rewrites the flags file. |
| **The command** | Links `omarchy-adblock` into `~/.local/bin`. Everything works without it from `bin/omarchy-adblock`. |

Without asking, it registers the native messaging host for Chromium (and for
Chrome, Brave or Edge if they are set up), and creates its own settings in
`~/.config/omarchy-adblock` and cache in `~/.local/share/omarchy-adblock`.
`./install.sh --yes` answers yes to all three. The default install adds **no
Python packages** and needs no root access; the local backend speaks OpenAI-compatible
HTTP from the standard library. Only `--with-anthropic` downloads anything, the
Anthropic SDK into a virtualenv in the cache folder.

Without the plugin system, clone anywhere and run `./install.sh` there.

Restart Chromium **completely** afterwards. A new window is not enough: the
flags and the host manifest are only read at browser startup.

**Requirements:** Chromium (ships with Omarchy), `python3`, `openssl`.
Optional: a local OpenAI-compatible model server, see below.

### Updates

About once every six hours the bar button fetches this repository's
`manifest.json` (one small HTTPS request, no personal data). If a newer version
is out, a dot appears on the button and the next click shows what changed, from
`CHANGELOG.md`. *Update…* opens a terminal that runs `omarchy plugin update`
(it shows the diff and asks), then `install.sh` (asks again), then offers to
restart Chromium, which loads the new extension only at a complete start.
*Later* hides that version. Set `"update_check": false` in
`~/.config/omarchy-adblock/config.json` to turn the check off. By hand:

```bash
omarchy plugin update fans.omarchy.chromium-ad-blocker
~/.config/omarchy/plugins/fans.omarchy.chromium-ad-blocker/install.sh
omarchy-adblock restart
```

See [docs/update-alerts.md](docs/update-alerts.md) for how it is built.

## Remove

```bash
cd ~/.config/omarchy/plugins/fans.omarchy.chromium-ad-blocker
./uninstall.sh
omarchy plugin disable fans.omarchy.chromium-ad-blocker
omarchy plugin remove fans.omarchy.chromium-ad-blocker
```

`uninstall.sh` takes back the flag, private mode's `--incognito`, the native host
manifests, the update hook and the command link. Learned rules, statistics and
local history stay in `~/.local/share/omarchy-adblock` for a reinstall; add
`--purge` to delete them along with the settings. Restart Chromium to finish.

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
- **The update check** is the one request the plugin makes on its own: this
  repository's `manifest.json` (and `CHANGELOG.md` when there is something
  new), about every six hours, with no personal data. `"update_check": false`
  in `~/.config/omarchy-adblock/config.json` turns it off.

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
- Removing a modal releases the scroll lock it left on `<body>`, and the blur:
  a blur filter on the page's content, or an empty blurred veil stacked over
  it. A page that cannot scroll, or cannot be read, is a worse bug than the
  popup was.
- Bot checks (DataDome, Cloudflare Turnstile, reCAPTCHA, hCaptcha, Arkose,
  PerimeterX) are never hidden, marked or un-blurred, and neither is anything
  wrapping one. Hiding one leaves a blurred page that can never be passed.
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

It installs through `omarchy plugin add` as a bar widget, and the browser half
follows Omarchy's own conventions: the same native-messaging-host pattern as
`omarchy-chromium-ytdlp`, the same `omarchy:summary=` script headers, and a
`post-update.d` hook so an Omarchy update does not quietly unwire it.

## Layout

```
manifest.json  Omarchy plugin manifest; BarWidget.qml is the bar button
browser/extension/
               MV3 extension — layers, chord, picker, popup
host/          native messaging host: rule cache on disk, the model call
bin/           the omarchy-adblock CLI
install.sh     idempotent installer; uninstall.sh reverses it
```

MIT.

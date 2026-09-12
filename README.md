# omarchy-chromium-ad-blocker

Filter lists go stale the week they ship. This reads the page instead and works
out what an ad is, on a model running on your own GPU, and it never has to phone
anyone to do it.

Three ways to use it. The default asks first.

| | |
|---|---|
| **Hold, look, delete** | Hold **Ctrl+Alt**. The page zooms out and every ad it found is outlined in red, with a count. **Delete** removes them. Let go instead and nothing happened. |
| **Point at one** | Press **P** during the chord, or *Pick one* in the popup. Click an ad and it goes, and that becomes a permanent note about that site in your own hand. |
| **Never ask again** | Turn on automatic mode and ads are removed as each page loads, before they paint. Off by default. |

## How it decides

Three layers, cheapest first. Nothing waits on the layer behind it.

| Layer | Catches | Cost |
|---|---|---|
| **Static rules** | Known ad slots, `adsbygoogle`, Taboola, doubleclick iframes | none |
| **DOM heuristics** | Cookie walls, newsletter modals, notification nags, scroll locks | none |
| **The model** | Whatever the first two were unsure about | one pass per site, ever |

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
or releasing either modifier to cancel. It is clear of everything that matters:
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

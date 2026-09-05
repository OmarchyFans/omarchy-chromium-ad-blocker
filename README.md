# Omarchy Ad Blocker (AI)

Safari on iOS lets you sweep the ads and overlays off a page you are reading.
This is that, for Omarchy's Chromium — except the last step is a model instead
of a hand-maintained filter list, so it can deal with a popup nobody has written
a rule for yet.

Three layers run in order, cheapest first. Nothing waits on the layer behind it.

| Layer | What it catches | Cost |
|---|---|---|
| **1. Static rules** | Known ad slots, `adsbygoogle`, Taboola/Outbrain, doubleclick iframes | none — CSS injected before first paint |
| **2. DOM heuristics** | Cookie walls, newsletter modals, "allow notifications", scroll locks | none — runs synchronously in the page |
| **3. Claude** | Whatever the first two were unsure about | one API call per site, then cached |

Layer 3 is the interesting one, and it is also the one that runs least. A site is
classified **once**. The verdicts are written to
`~/.local/share/omarchy-adblock/rules/<host>.json` and mirrored into extension
storage, which the content script reads at `document_start` — so on every later
visit the rules are applied before the page paints, with no round trip at all.

Both halves of the answer are cached. "This sticky bar is an ad" becomes a rule;
"this sticky bar is your nav" is remembered too, so a site with one legitimate
fixed header does not cost an API call on every page load forever.

Layers 1 and 2 work with no API key at all, and already handle most cookie walls.

## Install

```bash
git clone https://github.com/<you>/omarchy-adblock-ai.git ~/Work/omarchy-adblock-ai
cd ~/Work/omarchy-adblock-ai
./install.sh
omarchy-adblock key sk-ant-...      # optional — enables layer 3
omarchy-adblock restart
```

`install.sh` is idempotent and safe to re-run. It:

- derives the extension ID from the public key pinned in `manifest.json`
- adds the extension to the **existing** `--load-extension=` line in
  `~/.config/chromium-flags.conf` (Chromium honours only the last such flag, so
  appending a second one would silently unload Omarchy's own extensions)
- registers the native messaging host for Chromium, Chrome, Brave and Edge
- creates a virtualenv at `~/.local/share/omarchy-adblock/venv` for the SDK
- drops a hook in `~/.config/omarchy/hooks/post-update.d/` that re-applies both,
  since an Omarchy update may rewrite `chromium-flags.conf`

Restart Chromium **completely** afterwards — a new window is not enough, the
flags and the host manifest are only read at browser startup.

`./install.sh --no-ai` skips the virtualenv entirely if you only want layers 1
and 2. `./uninstall.sh` reverses everything; add `--purge` to also drop the
learned rules and your key.

## Using it

The toolbar button shows how many elements were removed on the page and gives
you three switches: blocking on/off, the AI pass on/off, and never block this
site. **Re-learn this site** throws away what the model concluded about the
current site, for when it got something wrong.

```bash
omarchy-adblock status           # what is installed, configured and learned
omarchy-adblock sites            # every site with learned rules
omarchy-adblock show nytimes.com # the rules learned for one site
omarchy-adblock forget nytimes.com
omarchy-adblock model claude-haiku-4-5
omarchy-adblock log              # why the AI pass went quiet
```

Chromium discards a native messaging host's stderr, so failures in layer 3 —
a bad key, an expired credential, a network error — would otherwise be invisible.
They go to `~/.local/share/omarchy-adblock/host.log`, and the most recent one
shows up in both `omarchy-adblock status` and the popup.

## What leaves your machine

An ad blocker that uploads your browsing would be a worse deal than the ads. So:

- **Page content is never sent.** The model sees a structural description of at
  most 25 candidate elements: tag, id, class names, CSS position, z-index, size,
  share of the viewport, counts of links/inputs/iframes — and at most **120
  characters** of text per element, which is what distinguishes "We use cookies"
  from a nav bar.
- **Most pages send nothing at all.** Layers 1 and 2 resolve the common cases
  locally, and a site that has been classified once never sends again.
- `localhost`, `127.0.0.1` and anything in `never_send` are excluded in the host
  itself, not just in the browser.
- Sites in the popup's allowlist are skipped before any layer runs.
- Nothing is sent when no API key is configured.

## Guardrails

The model's answer is not trusted on its own:

- It may only return selectors it was **shown**. A selector it invented is dropped.
- Page-blanking selectors (`body`, `div`, `*`, `main`, …) are rejected outright.
- Only selectors that match exactly one element are ever cached. A positional
  one (`:nth-child(4)`) is used to hide something now but never stored — it means
  a different element on the next page of the same site.
- Cached rules are re-checked against the live DOM once it exists. A rule that
  turns out to cover a login form, or to match a suspicious number of elements,
  is pulled back out of the stylesheet and the site is re-learned from scratch.
- Elements wrapping a `password` or credit-card field are never hidden, at any layer.
- Heuristic hits are hidden inline rather than by a rule, so a class-based match
  on one overlay cannot also hide a modal the user opens on purpose later.
- Known app hosts (Google Docs, Figma, Slack, GitHub, YouTube …) skip the
  heuristics entirely, because there an overlay is usually the app.
- When a modal is removed, the scroll lock it left on `<body>` is released — a
  page that cannot scroll reads as a worse bug than the popup did.

## Configuration

`~/.config/omarchy-adblock/config.json`:

```json
{
  "model": "claude-opus-5",
  "effort": "low",
  "cache_days": 30,
  "max_candidates": 25
}
```

`claude-opus-5` is the default because it reads ambiguous layouts best and it is
what Omarchy's own agent defaults to. `claude-haiku-4-5` is markedly cheaper and
faster and is a reasonable trade for this job — the call is a small structured
classification, and the result is cached either way. Switch with
`omarchy-adblock model claude-haiku-4-5`.

The API key lives in `~/.config/omarchy-adblock/env` (mode 600). It is read from
a file rather than the environment because Chromium launches the native host
without a login shell, so an `export` in `~/.bashrc` is invisible to it. An
`ant auth login` profile is picked up automatically if you have one.

## How it fits into Omarchy

Omarchy's `omarchy plugin add` installs Quickshell shell plugins — bar widgets,
panels, overlays. A browser extension is not one of those, so this ships as a
standalone repo that follows Omarchy's conventions instead of its plugin
registry: the same native-messaging-host pattern as `omarchy-chromium-ytdlp`,
the same `omarchy:summary=` script headers, and a `post-update.d` hook so an
Omarchy update does not quietly unwire it.

## Layout

```
extension/     MV3 extension — static rules, DOM heuristics, popup UI
host/          native messaging host: rule cache on disk, the Claude call
bin/           omarchy-adblock CLI
install.sh     idempotent installer; uninstall.sh reverses it
```

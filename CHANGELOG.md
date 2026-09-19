# Changelog

The bar button reads the newest sections of this file to tell you what changed
when an update is available. Keep one short line per bullet.

## 1.4.0

- An on/off switch at the top of the popup that says "Blocking is on" or "Blocking is off"
- The toolbar icon goes grey with an OFF badge when the blocker is off
- Nothing in the popup reloads the page any more, so no more "Reload site?" prompts

## 1.3.0

- The blocker now ships **off**: nothing is touched until you tick "1 · Block ads"
- `omarchy-adblock off` and `on` stop and start loading the extension in Chromium
- Turning the blocker off in the popup also stops tracker blocking and Global Privacy Control
- `omarchy-adblock off`, `on` and `incognito` ask before closing Chromium, and never close it from a script

## 1.2.2

- Hides small cookie bars that only offer "Accept"

## 1.2.1

- Removes sticky ad slots and paywall offers that load in frames, like The Independent's
- Popups that change after they first appear are checked again

## 1.2.0

- "Clean this site automatically" in the popup, and settings now apply without reloading the page
- Pages keep scrolling over embedded audio and video players
- Removes leftover dimming backdrops, sales and donation bars, and popups that appear late
- Declines cookie walls in frames and in French, German, Spanish, Italian, Dutch, Portuguese and Swedish
- No longer fights a site that keeps putting its notice back, which slowed some pages down

## 1.1.0

- The bar button shows a dot when a new version is out; click it for what changed and a one-click update
- `omarchy-adblock update-check`, `update-dismiss` and `update-run` from the command line

## 1.0.0

- Blocks ads, popups and sales offers, declines tracking-cookie dialogs, clears legal popups
- Optional model on your own GPU classifies what rules and heuristics miss
- The bar button shows what has been removed

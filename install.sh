#!/bin/bash

# Installs the Omarchy AI ad blocker: the Chromium extension, the native
# messaging host that backs it, and the update hook that keeps both wired up.
#
# Safe to re-run — every step is idempotent, which is also how the post-update
# hook repairs the install after an Omarchy update rewrites chromium-flags.conf.

set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$REPO/extension"
HOST_BIN="$REPO/host/omarchy-adblock-host"
HOST_NAME="com.omarchy.adblock"

CONFIG_DIR="$HOME/.config/omarchy-adblock"
DATA_DIR="$HOME/.local/share/omarchy-adblock"
VENV="$DATA_DIR/venv"
HOOK_DIR="$HOME/.config/omarchy/hooks/post-update.d"

SKIP_AI=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --no-ai) SKIP_AI=1 ;;
    --quiet) QUIET=1 ;;
    -h | --help)
      echo "Usage: ./install.sh [--no-ai] [--quiet]"
      echo "  --no-ai   Skip the Python virtualenv; heuristics and static rules only."
      echo "  --quiet   Suppress the closing summary (used by the post-update hook)."
      exit 0
      ;;
    *) echo "install.sh: unknown option: $arg" >&2; exit 1 ;;
  esac
done

say() { ((QUIET)) || echo "$@"; }
fail() { echo "install.sh: $*" >&2; exit 1; }

for cmd in python3 openssl; do
  command -v "$cmd" >/dev/null || fail "$cmd is required but not installed"
done
[[ -f "$EXT_DIR/manifest.json" ]] || fail "extension/manifest.json not found in $REPO"

# --- 1. Extension ID ---------------------------------------------------------
# With --load-extension the ID is derived from the load path unless the manifest
# pins a public key. It pins one, so the ID is the same for every install — and
# the native host will only accept messages from exactly this ID.

EXT_ID=$(python3 - "$EXT_DIR/manifest.json" <<'PY'
import base64, hashlib, json, sys
key = json.load(open(sys.argv[1]))["key"]
digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in digest))
PY
) || fail "could not derive the extension id from manifest.json"

say "Extension ID: $EXT_ID"

# --- 2. Python environment for the AI pass -----------------------------------

mkdir -p "$CONFIG_DIR" "$DATA_DIR/rules"
chmod 700 "$CONFIG_DIR"

if ((SKIP_AI)); then
  say "Skipping the Python environment (--no-ai): static rules and heuristics only."
else
  if [[ ! -x "$VENV/bin/python" ]]; then
    say "Creating the Python environment in $VENV …"
    python3 -m venv "$VENV" || fail "could not create the virtualenv at $VENV"
  fi
  say "Installing the anthropic SDK …"
  "$VENV/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1 || true
  "$VENV/bin/pip" install --quiet --upgrade anthropic \
    || fail "could not install the anthropic SDK; re-run with --no-ai to skip the AI pass"
fi

# --- 3. API key template -----------------------------------------------------
# The browser starts the host without a login shell, so a key exported from a
# shell profile is invisible to it. This file is the one that always works.

if [[ ! -f "$CONFIG_DIR/env" ]]; then
  cat >"$CONFIG_DIR/env" <<'ENVEOF'
# Omarchy ad blocker — the API key used to classify page elements.
# Get one at https://console.anthropic.com/settings/keys
#
# Until this is filled in, the blocker runs on static rules and DOM heuristics
# alone, which already handles most cookie walls and ad slots.
ANTHROPIC_API_KEY=
ENVEOF
  chmod 600 "$CONFIG_DIR/env"
fi

if [[ ! -f "$CONFIG_DIR/config.json" ]]; then
  cat >"$CONFIG_DIR/config.json" <<'CFGEOF'
{
  "model": "claude-haiku-4-5",
  "effort": "low",
  "cache_days": 30,
  "max_candidates": 25
}
CFGEOF
fi

# --- 4. Native messaging host ------------------------------------------------

chmod +x "$HOST_BIN"

BROWSER_DIRS=(
  "$HOME/.config/chromium"
  "$HOME/.config/google-chrome"
  "$HOME/.config/google-chrome-beta"
  "$HOME/.config/google-chrome-unstable"
  "$HOME/.config/BraveSoftware/Brave-Browser"
  "$HOME/.config/BraveSoftware/Brave-Browser-Beta"
  "$HOME/.config/microsoft-edge"
)

manifest=$(sed -e "s|__HOST_PATH__|$HOST_BIN|g" -e "s|__EXTENSION_ID__|$EXT_ID|g" \
  "$REPO/host/$HOST_NAME.json")

for dir in "${BROWSER_DIRS[@]}"; do
  mkdir -p "$dir/NativeMessagingHosts"
  printf '%s\n' "$manifest" >"$dir/NativeMessagingHosts/$HOST_NAME.json"
done
say "Registered the native messaging host for ${#BROWSER_DIRS[@]} browser profiles."

# --- 5. --load-extension ------------------------------------------------------
# Chromium takes the last --load-extension on the command line and ignores the
# rest, so this edits the existing flag in place. Appending a second one would
# silently unload Omarchy's own extensions.

edit_flags() {
  local file="$1"
  python3 - "$file" "$EXT_DIR" <<'PY'
import pathlib, sys

path, ext = pathlib.Path(sys.argv[1]), sys.argv[2]
lines = path.read_text().splitlines() if path.is_file() else []

for i, line in enumerate(lines):
    if line.startswith("--load-extension="):
        paths = [p for p in line.split("=", 1)[1].split(",") if p]
        if ext in paths:
            sys.exit(0)
        paths.append(ext)
        lines[i] = "--load-extension=" + ",".join(paths)
        break
else:
    lines.append("--load-extension=" + ext)

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text("\n".join(lines) + "\n")
print("updated")
PY
}

# Chromium ships with Omarchy, so its flags file is seeded from the packaged
# defaults when the user has never had one — otherwise adding our flag here
# would be the thing that drops Omarchy's Wayland settings.
OMARCHY_FLAGS="/usr/share/omarchy/config/chromium-flags.conf"
if [[ ! -f "$HOME/.config/chromium-flags.conf" && -f "$OMARCHY_FLAGS" ]]; then
  cp "$OMARCHY_FLAGS" "$HOME/.config/chromium-flags.conf"
fi

for flags in chromium-flags.conf chrome-flags.conf brave-flags.conf; do
  file="$HOME/.config/$flags"
  [[ -f $file || $flags == chromium-flags.conf ]] || continue
  if [[ -n $(edit_flags "$file") ]]; then
    say "Added the extension to $file"
  fi
done

# --- 6. Survive Omarchy updates ----------------------------------------------

mkdir -p "$HOOK_DIR"
cat >"$HOOK_DIR/omarchy-adblock" <<HOOKEOF
#!/bin/bash
# Re-applies the ad blocker's --load-extension flag and native host manifest,
# which an Omarchy update may have rewritten. Installed by omarchy-adblock-ai.
exec "$REPO/install.sh" --no-ai --quiet
HOOKEOF
chmod +x "$HOOK_DIR/omarchy-adblock"

# --- 7. CLI ------------------------------------------------------------------

mkdir -p "$HOME/.local/bin"
ln -sf "$REPO/bin/omarchy-adblock" "$HOME/.local/bin/omarchy-adblock"

# --- done --------------------------------------------------------------------

((QUIET)) && exit 0

cat <<DONE

  Installed.

  Extension ID   $EXT_ID
  Rule cache     $DATA_DIR/rules
  Settings       $CONFIG_DIR/config.json

  Next:
    1. Put your key in $CONFIG_DIR/env   (optional — heuristics work without it)
    2. Restart Chromium completely:  omarchy-adblock restart
    3. Check chrome://extensions shows "Omarchy Ad Blocker (AI)"

  Status any time:  omarchy-adblock status
DONE

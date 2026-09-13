#!/bin/bash

# Installs the Omarchy AI ad blocker: the Chromium extension, the native
# messaging host that backs it, and the update hook that keeps both wired up.
#
# Safe to re-run — every step is idempotent, which is also how the post-update
# hook repairs the install after an Omarchy update rewrites chromium-flags.conf.

set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$REPO/browser/extension"
HOST_BIN="$REPO/host/omarchy-adblock-host"
HOST_NAME="com.omarchy.adblock"

CONFIG_DIR="$HOME/.config/omarchy-adblock"
DATA_DIR="$HOME/.local/share/omarchy-adblock"
VENV="$DATA_DIR/venv"
HOOK_DIR="$HOME/.config/omarchy/hooks/post-update.d"

WITH_ANTHROPIC=0
QUIET=0
YES=0
REPAIR=0
for arg in "$@"; do
  case "$arg" in
    --with-anthropic) WITH_ANTHROPIC=1 ;;
    --yes | -y) YES=1 ;;
    --repair) REPAIR=1; QUIET=1 ;;
    --no-ai) REPAIR=1 ;;  # what the update hook from earlier versions passes
    --quiet) QUIET=1 ;;
    -h | --help)
      echo "Usage: ./install.sh [--with-anthropic] [--yes] [--quiet]"
      echo "  --with-anthropic  Also install the Anthropic SDK in a virtualenv, for"
      echo "                    machines with no GPU. The default backend is local"
      echo "                    and needs no Python packages at all."
      echo "  --yes             Answer yes to every question (Chromium flags, update"
      echo "                    hook, command link). Without it, each one is asked."
      echo "  --repair          Re-apply only what was already agreed to: the flag and"
      echo "                    the native host. Used by the post-update hook."
      echo "  --quiet           Suppress the closing summary."
      exit 0
      ;;
    *) echo "install.sh: unknown option: $arg" >&2; exit 1 ;;
  esac
done

say() { ((QUIET)) || echo "$@"; }
fail() { echo "install.sh: $*" >&2; exit 1; }

# Every change to a file that belongs to the person, not to this plugin, is
# asked about first. No terminal to ask on and no --yes means no.
ask() {
  ((YES)) && return 0
  [[ -t 0 ]] || return 1
  local reply
  read -r -p "$1 [y/N] " reply
  [[ $reply =~ ^[Yy] ]]
}

backup() {
  [[ -f $1 ]] || return 0
  local copy
  copy="$1.bak-omarchy-adblock-$(date +%Y%m%d-%H%M%S)"
  cp -p "$1" "$copy"
  say "  Backed up $1 to $copy"
}

for cmd in python3 openssl; do
  command -v "$cmd" >/dev/null || fail "$cmd is required but not installed"
done
[[ -f "$EXT_DIR/manifest.json" ]] || fail "browser/extension/manifest.json not found in $REPO"

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

# The local backend talks to an OpenAI-compatible server over plain HTTP from
# the standard library, so the default install adds no Python packages. The
# virtualenv exists only for people who want the Anthropic backend instead.
if ((WITH_ANTHROPIC)); then
  if [[ ! -x "$VENV/bin/python" ]]; then
    say "Creating the Python environment in $VENV …"
    python3 -m venv "$VENV" || fail "could not create the virtualenv at $VENV"
  fi
  say "Installing the anthropic SDK …"
  "$VENV/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1 || true
  "$VENV/bin/pip" install --quiet --upgrade anthropic \
    || fail "could not install the anthropic SDK"
fi

# --- 3. API key template -----------------------------------------------------
# The browser starts the host without a login shell, so a key exported from a
# shell profile is invisible to it. This file is the one that always works.

if ((!REPAIR)) && [[ ! -f "$CONFIG_DIR/env" ]]; then
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

if ((!REPAIR)) && [[ ! -f "$CONFIG_DIR/config.json" ]]; then
  cat >"$CONFIG_DIR/config.json" <<'CFGEOF'
{
  "backend": "local",
  "local_endpoint": "http://127.0.0.1:8080",
  "local_thinking": true,
  "mode": "manual",
  "model": "claude-haiku-4-5",
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

registered=0
for dir in "${BROWSER_DIRS[@]}"; do
  # Only browsers that are actually set up here, plus Chromium, which Omarchy
  # ships. Creating config folders for browsers nobody installed is clutter.
  [[ -d $dir || $dir == "$HOME/.config/chromium" ]] || continue
  mkdir -p "$dir/NativeMessagingHosts"
  printf '%s\n' "$manifest" >"$dir/NativeMessagingHosts/$HOST_NAME.json"
  registered=$((registered + 1))
done
say "Registered the native messaging host for $registered browser(s)."

# --- 5. --load-extension ------------------------------------------------------
# Chromium takes the last --load-extension on the command line and ignores the
# rest, so this edits the existing flag in place. Appending a second one would
# silently unload Omarchy's own extensions.

edit_flags() {
  local file="$1" mode="${2:-write}"
  python3 - "$file" "$EXT_DIR" "$mode" <<'PY'
import os, pathlib, sys

path, ext, mode = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = path.read_text().splitlines() if path.is_file() else []

for i, line in enumerate(lines):
    if line.startswith("--load-extension="):
        paths = [p for p in line.split("=", 1)[1].split(",") if p]
        # Drop paths that no longer exist. Moving or renaming this repo would
        # otherwise leave its old path in the flag forever, and Chromium refuses
        # to start cleanly with an extension directory it cannot read. Omarchy's
        # own entries live in /usr/share and are always present.
        stale = [p for p in paths if not os.path.isdir(p)]
        paths = [p for p in paths if p not in stale]
        if ext in paths and not stale:
            sys.exit(0)
        if ext not in paths:
            paths.append(ext)
        lines[i] = "--load-extension=" + ",".join(paths)
        if stale and mode != "check":
            print("dropped stale: " + ", ".join(stale), file=sys.stderr)
        break
else:
    lines.append("--load-extension=" + ext)

if mode == "check":
    print("needed")
    sys.exit(0)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text("\n".join(lines) + "\n")
print("updated")
PY
}

# Chromium ships with Omarchy, so its flags file is seeded from the packaged
# defaults when the user has never had one — otherwise adding our flag here
# would be the thing that drops Omarchy's Wayland settings.
OMARCHY_FLAGS="/usr/share/omarchy/config/chromium-flags.conf"
FLAGS_NEEDED=()
for flags in chromium-flags.conf chrome-flags.conf brave-flags.conf; do
  file="$HOME/.config/$flags"
  [[ -f $file || $flags == chromium-flags.conf ]] || continue
  [[ -n $(edit_flags "$file" check) ]] && FLAGS_NEEDED+=("$file")
done

FLAGS_OK=1
if ((${#FLAGS_NEEDED[@]})); then
  FLAGS_OK=0
  if ((REPAIR)); then
    # The hook only exists if the flag was agreed to at install time.
    FLAGS_OK=1
  else
    say
    say "Chromium loads the extension from a --load-extension line in:"
    ((QUIET)) || printf '  %s\n' "${FLAGS_NEEDED[@]}"
    say "Existing flags are kept, a timestamped backup is saved first, and"
    say "./uninstall.sh takes the line back out."
    ask "Add the extension to Chromium's startup flags?" && FLAGS_OK=1
  fi
fi

if ((FLAGS_OK)); then
  for file in "${FLAGS_NEEDED[@]}"; do
    if [[ $file == "$HOME/.config/chromium-flags.conf" && ! -f $file && -f $OMARCHY_FLAGS ]]; then
      cp "$OMARCHY_FLAGS" "$file"
    else
      ((REPAIR)) || backup "$file"
    fi
    edit_flags "$file" >/dev/null
    say "Added the extension to $file"
  done
else
  cat <<MANUAL

Skipped the Chromium flags. To load the extension by hand instead:
  1. Open chrome://extensions and turn on Developer mode
  2. Load unpacked: $EXT_DIR
  The ID stays $EXT_ID either way, so the native host still accepts it.
MANUAL
fi

# --- 5b. Is there a local model to talk to? ----------------------------------
# Checked rather than assumed. The local backend is the default, and on a fresh
# machine there is usually nothing listening yet — better to say so now than to
# leave someone wondering why only the obvious ads disappear.

LOCAL_ENDPOINT=$(python3 -c '
import json, pathlib
p = pathlib.Path.home()/".config/omarchy-adblock/config.json"
try:
    print(json.loads(p.read_text()).get("local_endpoint", "http://127.0.0.1:8080"))
except Exception:
    print("http://127.0.0.1:8080")
')

LOCAL_UP=0
if curl -sf --max-time 3 "$LOCAL_ENDPOINT/v1/models" >/dev/null 2>&1; then
  LOCAL_UP=1
fi

# --- 6. Survive Omarchy updates ----------------------------------------------
# An Omarchy update can rewrite chromium-flags.conf. The hook re-applies only the
# flag and the native host, and only if the flag was agreed to.

HOOK="$HOOK_DIR/omarchy-adblock"
if ((!REPAIR)) && ((FLAGS_OK)); then
  if [[ -f $HOOK ]] && grep -q -- "$REPO/install.sh --repair" "$HOOK"; then
    :
  elif ask "Re-apply the flag automatically after Omarchy updates (adds $HOOK)?"; then
    mkdir -p "$HOOK_DIR"
    cat >"$HOOK" <<HOOKEOF
#!/bin/bash
# Re-applies the Chromium ad blocker's --load-extension flag and native host
# manifest, which an Omarchy update may have rewritten. Removed by uninstall.sh.
exec "$REPO/install.sh" --repair
HOOKEOF
    chmod +x "$HOOK"
    say "Installed the post-update hook."
  fi
fi

# --- 7. CLI ------------------------------------------------------------------

LINK="$HOME/.local/bin/omarchy-adblock"
if ((!REPAIR)); then
  if [[ -L $LINK && $(readlink -f "$LINK") == "$REPO/bin/omarchy-adblock" ]]; then
    :
  elif [[ -e $LINK && ! -L $LINK ]]; then
    say "Left $LINK alone: it is a file this installer did not create."
  elif ask "Link the omarchy-adblock command into ~/.local/bin?"; then
    mkdir -p "$HOME/.local/bin"
    ln -sfn "$REPO/bin/omarchy-adblock" "$LINK"
    say "Linked $LINK"
  fi
fi

# --- done --------------------------------------------------------------------

((QUIET)) && exit 0

cat <<DONE

  Installed.

  Extension ID   $EXT_ID
  Rule cache     $DATA_DIR/rules
  Settings       $CONFIG_DIR/config.json

DONE

if ((LOCAL_UP)); then
  echo "  Local model    answering at $LOCAL_ENDPOINT"
else
  cat <<'NOMODEL'
  Local model    nothing answering — static rules and heuristics only

  The local backend expects an OpenAI-compatible server (llama.cpp's
  llama-server, ollama, vLLM). Omarchy's own local agent provides one:

      https://github.com/OmarchyFans/omarchy-fans-help

  Point somewhere else with:  omarchy-adblock endpoint http://host:port
  Or use the hosted model:    ./install.sh --with-anthropic
NOMODEL
fi

cat <<DONE2

  Next:
    1. Restart Chromium completely:  omarchy-adblock restart
       (or $REPO/bin/omarchy-adblock restart if you did not link the command)
    2. Hold Ctrl+Alt on any page to see what it found; press Delete to remove it

  Status any time:  omarchy-adblock status
DONE2

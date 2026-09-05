#!/bin/bash

# Removes everything install.sh put on the system. The rule cache is kept unless
# --purge is passed, so a reinstall does not have to re-learn every site.

set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$REPO/extension"
HOST_NAME="com.omarchy.adblock"
CONFIG_DIR="$HOME/.config/omarchy-adblock"
DATA_DIR="$HOME/.local/share/omarchy-adblock"

PURGE=0
[[ ${1:-} == "--purge" ]] && PURGE=1

for flags in chromium-flags.conf chrome-flags.conf brave-flags.conf; do
  file="$HOME/.config/$flags"
  [[ -f $file ]] || continue
  python3 - "$file" "$EXT_DIR" <<'PY'
import pathlib, sys

path, ext = pathlib.Path(sys.argv[1]), sys.argv[2]
lines = path.read_text().splitlines()
out = []
for line in lines:
    if line.startswith("--load-extension="):
        paths = [p for p in line.split("=", 1)[1].split(",") if p and p != ext]
        # Drop the flag entirely rather than leave "--load-extension=" behind,
        # which Chromium reads as an empty path and complains about on startup.
        if not paths:
            continue
        line = "--load-extension=" + ",".join(paths)
    out.append(line)
path.write_text("\n".join(out) + "\n")
PY
  echo "Cleaned $file"
done

find "$HOME/.config" -maxdepth 4 -name "$HOST_NAME.json" \
  -path "*/NativeMessagingHosts/*" -delete 2>/dev/null || true
echo "Removed the native messaging host manifests."

rm -f "$HOME/.config/omarchy/hooks/post-update.d/omarchy-adblock"
[[ -L "$HOME/.local/bin/omarchy-adblock" ]] && rm -f "$HOME/.local/bin/omarchy-adblock"

if ((PURGE)); then
  rm -rf "$DATA_DIR" "$CONFIG_DIR"
  echo "Purged the rule cache, settings and API key."
else
  rm -rf "$DATA_DIR/venv"
  echo "Kept the rule cache and settings in $DATA_DIR — pass --purge to remove them."
fi

echo
echo "Restart Chromium to finish removing the extension."

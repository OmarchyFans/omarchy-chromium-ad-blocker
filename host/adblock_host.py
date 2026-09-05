"""Omarchy Ad Blocker — native messaging host.

Chromium launches this process and speaks native messaging over stdio. It owns
the two things an extension cannot: the per-site rule cache on disk, and the
call to Claude.

Requests are handled on worker threads. A cache miss costs an API round trip of
several seconds, and the browser will keep sending messages during it — handling
them inline would stall every other tab behind one slow page.
"""

import json
import os
import re
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "omarchy-adblock"
DATA_DIR = Path.home() / ".local" / "share" / "omarchy-adblock"
RULES_DIR = DATA_DIR / "rules"
LOG_PATH = DATA_DIR / "host.log"

DEFAULTS = {
    # Opus 5 is the default because it is the model Omarchy's agent defaults to
    # and it reads ambiguous layouts best. Set "model" to "claude-haiku-4-5" in
    # config.json for a cheaper, faster pass — the schema is the same.
    "model": "claude-opus-5",
    "effort": "low",
    "cache_days": 30,
    "max_candidates": 25,
    # Hosts that never leave the machine, whatever the extension asks. A
    # homelab dashboard is exactly the kind of page with a fixed panel the AI
    # pass would want to ask about, and exactly the kind that should not be
    # described to anyone.
    "never_send": ["localhost", "127.0.0.1", "0.0.0.0", "::1"],
    "never_send_suffixes": [".local", ".lan", ".internal", ".home.arpa", ".test"],
}

CACHE_VERSION = 1

# A selector broad enough to blank the page is never something we act on, no
# matter how confident the model was.
FORBIDDEN_SELECTORS = {
    "*", "html", "body", "head", "main", "article", "div", "span", "section",
    "nav", "header", "footer", "form", "a", "p", "ul", "li", "img", "table",
    "body *", "html *", ":root",
}

SYSTEM_PROMPT = """\
You decide which page elements are advertising or interruptions, and which are \
the site itself.

You are given structural descriptions of candidate elements from one web page: \
tag, id, class names, CSS position, z-index, size, share of the viewport \
covered, counts of links/inputs/iframes, and at most 120 characters of text. \
You never see the page content itself.

Block an element only when it is one of:
- an advertisement, sponsored unit, or ad slot container
- a cookie or consent wall
- a newsletter, subscribe, register, or paywall-nag modal
- an "allow notifications" or "disable your ad blocker" interstitial
- a modal backdrop belonging to any of the above

Never block:
- site navigation, search, headers, footers, breadcrumbs
- the page's main content or media player
- login, signup, checkout, or any form the user chose to open
- cart, account, or settings panels
- toolbars belonging to a web app the user is using

When a candidate is ambiguous, leave it alone. A missed ad is a small annoyance; \
a hidden checkout button breaks the site. Return only selectors from the \
candidate list, verbatim.\
"""


# ----------------------------------------------------------------- transport

_stdout_lock = threading.Lock()
_log_lock = threading.Lock()


def log(message):
    """Chromium discards a native host's stderr, so a failure here is invisible
    unless it is written down. This file is what `omarchy-adblock status` reads
    when the AI pass has quietly stopped working."""
    try:
        with _log_lock:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            with LOG_PATH.open("a") as fh:
                fh.write(f"{stamp}  {message}\n")
            if LOG_PATH.stat().st_size > 256 * 1024:
                tail = LOG_PATH.read_text().splitlines()[-500:]
                LOG_PATH.write_text("\n".join(tail) + "\n")
    except OSError:
        pass


def read_message():
    """Read one native-messaging frame: 4-byte LE length, then UTF-8 JSON."""
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    if length == 0 or length > 8 * 1024 * 1024:
        return None
    body = sys.stdin.buffer.read(length)
    if len(body) < length:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {}


def send_message(obj):
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    with _stdout_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


# -------------------------------------------------------------------- config


def load_config():
    cfg = dict(DEFAULTS)
    path = CONFIG_DIR / "config.json"
    if path.is_file():
        try:
            cfg.update(json.loads(path.read_text()))
        except (ValueError, OSError):
            pass
    return cfg


ANTHROPIC_PROFILE_DIR = Path.home() / ".config" / "anthropic"


def load_api_key():
    """Environment first, then the module's own env file.

    The browser launches this host without a login shell, so an API key exported
    in ~/.bashrc is not visible here — the env file is the path that actually
    works for most people.
    """
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    env_file = CONFIG_DIR / "env"
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            if name.strip() in ("ANTHROPIC_API_KEY", "export ANTHROPIC_API_KEY"):
                return value.strip().strip("'\"")
    return ""


def have_credentials():
    """An unset key does not mean no credentials.

    `ant auth login` leaves an OAuth profile on disk that the SDK picks up from
    a zero-argument client — which works here precisely because it is a file and
    not an environment variable the browser stripped.
    """
    return bool(load_api_key()) or ANTHROPIC_PROFILE_DIR.is_dir()


def notify(title, body="", urgency="normal"):
    """Best effort — a missing notification must never fail a request."""
    try:
        subprocess.run(
            ["omarchy-notification-send", "-u", urgency, "-g", "󰩿", title, body],
            timeout=5,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        pass


# --------------------------------------------------------------------- cache

HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9._-]{0,252}[A-Za-z0-9])?$")


def safe_host(host):
    """A hostname is a cache filename, so it is validated, never sanitized.

    Rejecting outright is the only safe answer: a name that needed cleaning up
    was not a hostname, and a cleaned-up one could still collide with a real
    site's cache entry.
    """
    if not isinstance(host, str) or not HOST_RE.match(host) or ".." in host:
        return None
    return host.lower()


# 10/8, 172.16/12 and 192.168/16, plus loopback — matched as text because the
# hostname is all we have and a private address is never worth describing.
PRIVATE_IP_RE = re.compile(
    r"^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)"
)


def is_private(host, cfg):
    if any(host == n or host.endswith("." + n) for n in cfg["never_send"]):
        return True
    if any(host.endswith(sfx) for sfx in cfg.get("never_send_suffixes", [])):
        return True
    # A single-label name ("nas", "router") only ever resolves on a local network.
    return bool(PRIVATE_IP_RE.match(host)) or "." not in host


def cache_path(host):
    return RULES_DIR / f"{host}.json"


def read_cache(host, cache_days):
    path = cache_path(host)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text())
    except (ValueError, OSError):
        return None
    if data.get("version") != CACHE_VERSION:
        return None
    if time.time() - data.get("updated", 0) > cache_days * 86400:
        return None
    block = data.get("block")
    asked = data.get("asked")
    return {
        "block": block if isinstance(block, list) else [],
        # Every selector the model has ruled on, block or not. Without the "not",
        # one legitimate sticky header on a busy site is an API call per page load.
        "asked": asked if isinstance(asked, list) else [],
    }


def write_cache(host, block, asked, model):
    RULES_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": CACHE_VERSION,
        "host": host,
        "model": model,
        "updated": int(time.time()),
        "block": block,
        "asked": asked,
    }
    tmp = cache_path(host).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2))
    tmp.replace(cache_path(host))


def merge_cache(host, new_block, new_asked, model, cache_days):
    prev = read_cache(host, cache_days) or {"block": [], "asked": []}
    block = list(dict.fromkeys(prev["block"] + new_block))[:120]
    asked = list(dict.fromkeys(prev["asked"] + new_asked))[:400]
    write_cache(host, block, asked, model)
    return block, asked


# ------------------------------------------------------------------ the model

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "block": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Selectors from the candidate list to hide. Empty if none qualify.",
        }
    },
    "required": ["block"],
    "additionalProperties": False,
}


def sanitize_candidate(c, max_text=120):
    """Rebuild each candidate field by field.

    Whatever a page put in an id or a class name reaches us through the content
    script, so nothing from the browser is forwarded as-is — an unknown field
    would be a channel from the page straight into the prompt.
    """
    if not isinstance(c, dict):
        return None
    selector = c.get("selector")
    if not isinstance(selector, str) or not 0 < len(selector) <= 300:
        return None

    def num(key):
        v = c.get(key)
        return int(v) if isinstance(v, (int, float)) and abs(v) < 10**7 else 0

    def text(key, cap):
        v = c.get(key)
        return re.sub(r"\s+", " ", v)[:cap] if isinstance(v, str) else ""

    return {
        "selector": selector,
        "tag": text("tag", 20),
        "id": text("id", 60),
        "cls": text("cls", 120),
        "pos": text("pos", 12),
        "z": num("z"),
        "size": f"{num('w')}x{num('h')}",
        "viewport_pct": num("area"),
        "links": num("links"),
        "inputs": num("inputs"),
        "iframes": num("iframes"),
        "text": text("text", max_text),
    }


def classify(host, candidates, cfg, api_key):
    """Ask Claude which candidates are ads. Returns a list of selectors."""
    try:
        import anthropic
    except ImportError:
        return [], "sdk-missing"

    allowed = {c["selector"] for c in candidates}
    user_content = json.dumps(
        {"site": host, "candidates": candidates}, separators=(",", ":")
    )

    try:
        # An explicit key wins; without one the SDK resolves the `ant auth login`
        # profile itself. Constructing inside the try matters: a profile
        # directory that exists but holds no usable credential raises here, not
        # at the request.
        client = (
            anthropic.Anthropic(api_key=api_key, timeout=25.0, max_retries=1)
            if api_key
            else anthropic.Anthropic(timeout=25.0, max_retries=1)
        )
        response = client.beta.messages.create(
            model=cfg["model"],
            max_tokens=2000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_content}],
            output_config={
                "effort": cfg["effort"],
                "format": {"type": "json_schema", "schema": RESPONSE_SCHEMA},
            },
            # A refusal here would otherwise return a 200 with no usable content
            # and leave the page un-blocked for no visible reason.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except Exception as exc:  # noqa: BLE001 — any failure degrades to heuristics
        log(f"classify {host}: {type(exc).__name__}: {str(exc)[:300]}")
        return [], type(exc).__name__

    if getattr(response, "stop_reason", None) == "refusal":
        return [], "refusal"

    text = next(
        (b.text for b in response.content if getattr(b, "type", None) == "text"), None
    )
    if not text:
        return [], "empty"
    try:
        block = json.loads(text).get("block", [])
    except ValueError:
        return [], "unparseable"

    # The model may only pick from what it was shown. Anything else is a
    # hallucinated selector, and a broad one would blank the page.
    clean = [
        s for s in block
        if isinstance(s, str)
        and s in allowed
        and s.strip().lower() not in FORBIDDEN_SELECTORS
    ]
    return clean, "ok"


# ------------------------------------------------------------------ requests

_notified = set()


def notify_once(key, title, body, urgency="normal"):
    if key in _notified:
        return
    _notified.add(key)
    notify(title, body, urgency)


def handle(msg, cfg):
    op = msg.get("op")
    reply = {"id": msg.get("id"), "block": []}

    if op == "status":
        last_error = ""
        if LOG_PATH.is_file():
            try:
                lines = [l for l in LOG_PATH.read_text().splitlines() if l.strip()]
                last_error = lines[-1] if lines else ""
            except OSError:
                pass
        reply.update(
            ai_ready=have_credentials(),
            model=cfg["model"],
            cached_sites=len(list(RULES_DIR.glob("*.json"))) if RULES_DIR.is_dir() else 0,
            last_error=last_error,
        )
        return reply

    host = safe_host(msg.get("host"))
    if not host:
        reply["error"] = "bad-host"
        return reply

    if op == "forget":
        cache_path(host).unlink(missing_ok=True)
        reply["forgot"] = host
        return reply

    if op == "rules":
        cached = read_cache(host, cfg["cache_days"]) or {"block": [], "asked": []}
        reply["block"] = cached["block"]
        reply["asked"] = cached["asked"]
        reply["source"] = "cache"
        return reply

    if op != "classify":
        reply["error"] = "bad-op"
        return reply

    if is_private(host, cfg):
        reply["error"] = "host-excluded"
        return reply

    raw = msg.get("candidates")
    if not isinstance(raw, list) or not raw:
        return reply

    candidates = [
        c for c in (sanitize_candidate(x) for x in raw[: cfg["max_candidates"]]) if c
    ]
    if not candidates:
        return reply

    if not have_credentials():
        notify_once(
            "no-key",
            "Ad blocker: heuristics only",
            "Add ANTHROPIC_API_KEY to ~/.config/omarchy-adblock/env to let Claude classify the rest.",
        )
        reply["error"] = "no-api-key"
        return reply
    api_key = load_api_key()

    block, status = classify(host, candidates, cfg, api_key)
    if status == "sdk-missing":
        notify_once(
            "no-sdk",
            "Ad blocker: Python SDK missing",
            "Re-run install.sh to rebuild the virtualenv.",
            "critical",
        )

    if status == "ok":
        # Record the whole batch as asked, not just the ones that came back as
        # ads — a "leave this alone" is the more valuable half of the answer,
        # because it is the one that would otherwise be re-asked forever.
        asked = [c["selector"] for c in candidates]
        reply["block"], reply["asked"] = merge_cache(
            host, block, asked, cfg["model"], cfg["cache_days"]
        )
    elif status != "ok":
        log(f"classify {host}: {status}")

    reply["source"] = status
    return reply


def respond(msg, cfg):
    """One request, one reply — even when handling it blows up.

    A worker that dies without writing anything leaves the extension waiting out
    its full timeout with nothing to show for it, so the failure has to come back
    as a message and go to the log where someone can find it.
    """
    try:
        reply = handle(msg, cfg)
    except Exception as exc:  # noqa: BLE001
        log(f"handle {msg.get('op')}: {type(exc).__name__}: {str(exc)[:300]}")
        reply = {"id": msg.get("id"), "block": [], "error": "internal"}
    try:
        send_message(reply)
    except (BrokenPipeError, OSError):
        pass


def main():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    RULES_DIR.mkdir(parents=True, exist_ok=True)
    cfg = load_config()

    workers = []
    while True:
        msg = read_message()
        if msg is None:
            break
        if not msg:
            continue
        t = threading.Thread(target=respond, args=(msg, cfg), daemon=True)
        t.start()
        workers.append(t)
        workers = [w for w in workers if w.is_alive()]

    # Chromium closed the pipe, or is about to. Give in-flight requests a chance
    # to answer before this process exits — returning from main() would kill the
    # daemon threads mid-call and the extension would see a silent disconnect
    # rather than the classification it asked for.
    deadline = time.monotonic() + 30
    for worker in workers:
        worker.join(timeout=max(0.0, deadline - time.monotonic()))


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass

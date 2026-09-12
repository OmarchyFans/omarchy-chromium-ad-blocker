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
import urllib.error
import urllib.request
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "omarchy-adblock"
DATA_DIR = Path.home() / ".local" / "share" / "omarchy-adblock"
RULES_DIR = DATA_DIR / "rules"
# Rules the user pointed at and called an ad, kept apart from what the model
# worked out. These are a person's stated intent, so nothing expires them,
# re-learning a site does not clear them, and the DOM audit leaves them alone.
USER_DIR = DATA_DIR / "user"
LOG_PATH = DATA_DIR / "host.log"
STATS_PATH = DATA_DIR / "stats.json"
HISTORY_PATH = DATA_DIR / "history.jsonl"

DEFAULTS = {
    # "local" runs on your own GPU and is the default: nothing about a page you
    # visit leaves the machine, there is no key to configure and no per-call
    # cost. "anthropic" is the opt-in alternative for a machine with no GPU.
    "backend": "local",
    # Any OpenAI-compatible server: llama.cpp's llama-server, ollama, vLLM.
    # Omarchy's own local agent (omarchy-local-agent.service) serves this one.
    "local_endpoint": "http://127.0.0.1:8080",
    # Left on deliberately. On a 4B model it is the difference between catching
    # one ad in three and catching all three without touching the checkout form,
    # and it is paid once per site rather than once per page.
    "local_thinking": True,
    # Generous: llama-server with --parallel 1 queues behind whatever else is
    # asking it something, and a 25-candidate batch is ~6s of actual work.
    "local_timeout": 120,
    # Used only when backend is "anthropic". The cheapest current model, and the
    # job suits it: a small, tightly schema'd classification, cached per site.
    "model": "claude-haiku-4-5",
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

# Not every model takes the same request. `effort` is rejected outright by Haiku
# 4.5 and Sonnet 4.5, and the server-side refusal fallback only exists on the
# models that can return stop_reason "refusal" in the first place — so both are
# sent only where they mean something rather than assumed and swallowed by the
# error path. An unlisted model is sent the plain request, which every model
# accepts.
MODEL_FEATURES = {
    "claude-haiku-4-5": set(),
    "claude-sonnet-4-6": {"effort"},
    "claude-sonnet-5": {"effort"},
    "claude-opus-4-6": {"effort"},
    "claude-opus-4-7": {"effort", "fallbacks"},
    "claude-opus-4-8": {"effort", "fallbacks"},
    "claude-opus-5": {"effort", "fallbacks"},
    "claude-fable-5": {"effort", "fallbacks"},
    "claude-fable-5-1": {"effort", "fallbacks"},
}


def model_supports(model, feature):
    return feature in MODEL_FEATURES.get(model, set())


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


def local_server_up(cfg):
    """Is there actually a model listening? Checked rather than assumed: the
    local backend is the default, and most people's first install will not have
    one running yet."""
    url = cfg["local_endpoint"].rstrip("/") + "/v1/models"
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:
            return resp.status == 200
    except Exception:  # noqa: BLE001
        return False


def backend_ready(cfg):
    if cfg.get("backend", "local") == "anthropic":
        return have_credentials()
    return local_server_up(cfg)


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


# --------------------------------------------------------------------- stats

_stats_lock = threading.Lock()

# The four things this removes, counted separately because they are different
# claims: an ad hidden, a request never made, a consent dialog actually answered,
# and a legal notice taken off the page.
STAT_KINDS = ("ads", "trackers", "consent", "legal")


def read_stats():
    if not STATS_PATH.is_file():
        return {"totals": {k: 0 for k in STAT_KINDS}, "sites": {}}
    try:
        data = json.loads(STATS_PATH.read_text())
    except (ValueError, OSError):
        return {"totals": {k: 0 for k in STAT_KINDS}, "sites": {}}
    totals = data.get("totals") or {}
    return {
        "totals": {k: int(totals.get(k, 0) or 0) for k in STAT_KINDS},
        "sites": data.get("sites") if isinstance(data.get("sites"), dict) else {},
    }


def bump_stats(host, counts):
    """Add to the running totals. Called on commit, never on mark: in manual
    mode nothing has been removed until Delete, so nothing is counted."""
    clean = {k: int(v) for k, v in counts.items()
             if k in STAT_KINDS and isinstance(v, (int, float)) and 0 < v < 100000}
    if not clean:
        return read_stats()
    with _stats_lock:
        stats = read_stats()
        for k, v in clean.items():
            stats["totals"][k] += v
        site = stats["sites"].setdefault(host, {k: 0 for k in STAT_KINDS})
        for k, v in clean.items():
            site[k] = int(site.get(k, 0)) + v
        site["last"] = int(time.time())
        # Keep the per-site table from growing without bound; the totals are
        # what the numbers are really for.
        if len(stats["sites"]) > 2000:
            ranked = sorted(stats["sites"].items(),
                            key=lambda kv: kv[1].get("last", 0), reverse=True)
            stats["sites"] = dict(ranked[:1500])
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            tmp = STATS_PATH.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(stats, indent=1))
            tmp.replace(STATS_PATH)
        except OSError as exc:
            log(f"stats write failed: {exc}")
        return stats


# ------------------------------------------------------------------- history

_history_lock = threading.Lock()


def record_visit(url, title):
    """Incognito keeps no history, which is the point — but losing every page
    you have ever read is not what most people mean by private. This file is
    that history, on your disk, readable by you and nothing else."""
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return False
    entry = {
        "ts": int(time.time()),
        "url": url[:2000],
        "title": (title if isinstance(title, str) else "")[:300],
    }
    with _history_lock:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            existed = HISTORY_PATH.exists()
            with HISTORY_PATH.open("a") as fh:
                fh.write(json.dumps(entry) + "\n")
            if not existed:
                HISTORY_PATH.chmod(0o600)
        except OSError as exc:
            log(f"history write failed: {exc}")
            return False
    return True


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


def user_path(host):
    return USER_DIR / f"{host}.json"


def read_user_rules(host):
    path = user_path(host)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text())
    except (ValueError, OSError):
        return []
    block = data.get("block")
    return block if isinstance(block, list) else []


def add_user_rule(host, selector):
    """Record one hand-marked ad. Returns the site's full user list."""
    if selector.strip().lower() in FORBIDDEN_SELECTORS:
        return read_user_rules(host)
    USER_DIR.mkdir(parents=True, exist_ok=True)
    block = list(dict.fromkeys(read_user_rules(host) + [selector]))[:200]
    payload = {
        "version": CACHE_VERSION,
        "host": host,
        "source": "user",
        "updated": int(time.time()),
        "block": block,
    }
    tmp = user_path(host).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2))
    tmp.replace(user_path(host))
    return block


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


def validate_block(block, candidates):
    """Keep only what the model was actually allowed to say.

    Shared by both backends: a model may only return selectors it was shown, and
    never one broad enough to blank the page. A hallucinated or over-broad
    selector is the one failure mode that would break a site rather than merely
    leave an ad on it, so it is filtered here rather than trusted anywhere.
    """
    allowed = {c["selector"] for c in candidates}
    return [
        sel for sel in block
        if isinstance(sel, str)
        and sel in allowed
        and sel.strip().lower() not in FORBIDDEN_SELECTORS
    ]


def build_prompt(host, candidates, user_marked):
    payload = {"site": host, "candidates": candidates}
    if user_marked:
        # What this person has already called an ad on this site, in their own
        # clicks. Worth more than anything in the prompt: it is ground truth for
        # this exact site, and it teaches the shape of the rest.
        payload["user_marked_as_ads_on_this_site"] = user_marked[:20]
    return json.dumps(payload, separators=(",", ":"))


# ------------------------------------------------------------ consent model

CONSENT_PROMPT = """\
You are shown the text of a cookie-consent or privacy dialog and the buttons in \
it. Pick the one button that declines: rejects all non-essential cookies, \
refuses tracking, or keeps only what is strictly necessary.

Never pick a button that accepts, agrees, allows, or opens a settings page \
without deciding. If no button declines, return an empty selector. Return the \
selector of the chosen button exactly as given.\
"""

CONSENT_SCHEMA = {
    "type": "object",
    "properties": {"selector": {"type": "string"}},
    "required": ["selector"],
    "additionalProperties": False,
}

# Words that mean yes. A model that picks one of these has picked wrong, and
# clicking it would do the opposite of what was asked, so it is refused here
# whatever the model thought.
ACCEPT_WORDS = re.compile(
    r"\b(accept|agree|allow|consent|ok|okay|got it|continue|yes|enable|i understand)\b", re.I)
DECLINE_WORDS = re.compile(
    r"\b(reject|decline|refuse|deny|necessary|essential|required only|disagree|opt out|no thanks|without)\b", re.I)


def consent_path(host):
    return RULES_DIR / f"consent-{host}.json"


def classify_consent(host, dialog, buttons, cfg):
    """Which button says no. Cached per site: a site's dialog is the same dialog
    on every page, so this is asked once."""
    cached = consent_path(host)
    if cached.is_file():
        try:
            data = json.loads(cached.read_text())
            if time.time() - data.get("updated", 0) < cfg["cache_days"] * 86400:
                return data.get("selector", ""), "cache"
        except (ValueError, OSError):
            pass

    clean = []
    for b in buttons[:12]:
        if not isinstance(b, dict) or not isinstance(b.get("selector"), str):
            continue
        clean.append({
            "selector": b["selector"][:200],
            "label": re.sub(r"\s+", " ", str(b.get("label", "")))[:60],
            "tag": str(b.get("tag", ""))[:12],
            "cls": str(b.get("cls", ""))[:80],
        })
    if not clean:
        return "", "no-buttons"

    endpoint = cfg["local_endpoint"].rstrip("/") + "/v1/chat/completions"
    body = {
        "model": "local", "max_tokens": 500, "temperature": 0,
        "messages": [
            {"role": "system", "content": CONSENT_PROMPT},
            {"role": "user", "content": json.dumps(
                {"dialog": str(dialog)[:300], "buttons": clean}, separators=(",", ":"))},
        ],
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "decline", "strict": True, "schema": CONSENT_SCHEMA}},
    }
    if not cfg.get("local_thinking", True):
        body["chat_template_kwargs"] = {"enable_thinking": False}
    try:
        req = urllib.request.Request(endpoint, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=cfg["local_timeout"]) as resp:
            data = json.load(resp)
        chosen = json.loads(data["choices"][0]["message"]["content"]).get("selector", "")
    except Exception as exc:  # noqa: BLE001
        log(f"consent {host}: {type(exc).__name__}: {str(exc)[:200]}")
        return "", "error"

    by_sel = {b["selector"]: b for b in clean}
    pick = by_sel.get(chosen)
    if not pick:
        return "", "not-offered"
    label = pick["label"]
    if ACCEPT_WORDS.search(label) and not DECLINE_WORDS.search(label):
        log(f"consent {host}: refused model pick '{label}' — reads as accept")
        return "", "refused-accept"

    try:
        RULES_DIR.mkdir(parents=True, exist_ok=True)
        consent_path(host).write_text(json.dumps(
            {"host": host, "selector": chosen, "label": label, "updated": int(time.time())}))
    except OSError:
        pass
    return chosen, "ok"


# ------------------------------------------------------------- local backend


def classify_local(host, candidates, cfg, user_marked):
    """Classify on the local GPU through an OpenAI-compatible server.

    Uses urllib rather than an SDK on purpose: the default install then needs no
    Python packages at all, which is most of what made the local backend worth
    having.
    """
    endpoint = cfg["local_endpoint"].rstrip("/") + "/v1/chat/completions"
    body = {
        "model": "local",  # llama-server serves whatever it was started with
        "max_tokens": 700,
        # Deterministic: the same page asked twice gives the same answer, which
        # is what makes a cached verdict trustworthy.
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_prompt(host, candidates, user_marked)},
        ],
        # Not response_format "json_object" — that asks nicely and a 4B model
        # answers with prose. A json_schema constrains generation itself, so the
        # reply parses or the server refuses the request.
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "ads", "strict": True, "schema": RESPONSE_SCHEMA},
        },
    }
    if not cfg.get("local_thinking", True):
        body["chat_template_kwargs"] = {"enable_thinking": False}

    req = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=cfg["local_timeout"]) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode()[:200]
        except OSError:
            pass
        log(f"classify {host}: local HTTP {exc.code}: {detail}")
        return [], f"local-http-{exc.code}"
    except urllib.error.URLError as exc:
        log(f"classify {host}: local server unreachable at {endpoint}: {exc.reason}")
        return [], "local-unreachable"
    except Exception as exc:  # noqa: BLE001 — any failure degrades to heuristics
        log(f"classify {host}: local {type(exc).__name__}: {str(exc)[:200]}")
        return [], type(exc).__name__

    try:
        content = data["choices"][0]["message"]["content"]
        block = json.loads(content).get("block", [])
    except (KeyError, IndexError, TypeError, ValueError):
        log(f"classify {host}: local reply not usable: {str(data)[:200]}")
        return [], "unparseable"

    return validate_block(block, candidates), "ok"


# --------------------------------------------------------- anthropic backend


def classify_anthropic(host, candidates, cfg, user_marked, api_key):
    try:
        import anthropic
    except ImportError:
        return [], "sdk-missing"

    model = cfg["model"]
    output_config = {"format": {"type": "json_schema", "schema": RESPONSE_SCHEMA}}
    if model_supports(model, "effort"):
        output_config["effort"] = cfg["effort"]

    params = {
        "model": model,
        "max_tokens": 2000,
        "system": SYSTEM_PROMPT,
        "messages": [
            {"role": "user", "content": build_prompt(host, candidates, user_marked)}
        ],
        "output_config": output_config,
    }
    if model_supports(model, "fallbacks"):
        # A refusal would otherwise return a 200 with no usable content and leave
        # the page un-blocked for no visible reason.
        params["betas"] = ["server-side-fallback-2026-07-01"]
        params["fallbacks"] = "default"

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
        response = client.beta.messages.create(**params)
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

    return validate_block(block, candidates), "ok"


def classify(host, candidates, cfg, user_marked=None):
    user_marked = user_marked or []
    if cfg.get("backend", "local") == "anthropic":
        return classify_anthropic(host, candidates, cfg, user_marked, load_api_key())
    return classify_local(host, candidates, cfg, user_marked)


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

    if op == "stats":
        reply.update(read_stats())
        return reply

    if op == "status":
        last_error = ""
        if LOG_PATH.is_file():
            try:
                lines = [l for l in LOG_PATH.read_text().splitlines() if l.strip()]
                last_error = lines[-1] if lines else ""
            except OSError:
                pass
        backend = cfg.get("backend", "local")
        reply.update(
            ai_ready=backend_ready(cfg),
            backend=backend,
            model=cfg["model"] if backend == "anthropic" else cfg["local_endpoint"],
            cached_sites=len(list(RULES_DIR.glob("*.json"))) if RULES_DIR.is_dir() else 0,
            last_error=last_error,
        )
        return reply

    if op == "visit":
        # Either switch turns it on: the popup's (sent with the request) or
        # `omarchy-adblock private on` (in the config). Otherwise the URL is
        # dropped here, never written.
        if msg.get("requested") is True or cfg.get("history") is True:
            reply["recorded"] = record_visit(msg.get("url"), msg.get("title"))
        else:
            reply["recorded"] = False
        return reply

    host = safe_host(msg.get("host"))
    if not host:
        reply["error"] = "bad-host"
        return reply

    if op == "consent":
        if is_private(host, cfg):
            reply["error"] = "host-excluded"
            return reply
        if cfg.get("backend", "local") != "local" or not local_server_up(cfg):
            reply["error"] = "no-local-model"
            return reply
        buttons = msg.get("buttons")
        selector, status = classify_consent(
            host, msg.get("dialog", ""), buttons if isinstance(buttons, list) else [], cfg)
        reply["selector"] = selector
        reply["source"] = status
        return reply

    if op == "stat":
        counts = msg.get("counts")
        reply.update(bump_stats(host, counts if isinstance(counts, dict) else {}))
        return reply

    if op == "forget":
        consent_path(host).unlink(missing_ok=True)
        # Only what the model worked out. A hand-marked ad is not a guess to be
        # thrown away when a guess turns out wrong.
        cache_path(host).unlink(missing_ok=True)
        if msg.get("include_user"):
            user_path(host).unlink(missing_ok=True)
        reply["forgot"] = host
        reply["user"] = read_user_rules(host)
        return reply

    if op == "rules":
        cached = read_cache(host, cfg["cache_days"]) or {"block": [], "asked": []}
        reply["block"] = cached["block"]
        reply["asked"] = cached["asked"]
        # Sent separately, not merged: the content script must know which rules
        # came from the person so it never audits one of them away.
        reply["user"] = read_user_rules(host)
        reply["source"] = "cache"
        return reply

    if op == "learn":
        selector = msg.get("selector")
        if not isinstance(selector, str) or not 0 < len(selector) <= 300:
            reply["error"] = "bad-selector"
            return reply
        reply["user"] = add_user_rule(host, selector)
        reply["learned"] = selector
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

    if not backend_ready(cfg):
        if cfg.get("backend", "local") == "anthropic":
            notify_once(
                "no-key",
                "Ad blocker: heuristics only",
                "Add ANTHROPIC_API_KEY to ~/.config/omarchy-adblock/env to let Claude classify the rest.",
            )
            reply["error"] = "no-api-key"
        else:
            notify_once(
                "no-local",
                "Ad blocker: heuristics only",
                f"No model answering at {cfg['local_endpoint']}. Run `omarchy-adblock backend` to set one up.",
            )
            reply["error"] = "no-local-model"
        return reply

    # A rule the user marked by hand is ground truth for this site, so it goes
    # into the prompt as an example rather than being kept to one side.
    block, status = classify(host, candidates, cfg, read_user_rules(host))
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
        # Name whatever actually answered. Recording cfg["model"] here wrote an
        # Anthropic model id into caches produced by the local GPU.
        answered_by = (
            cfg["model"] if cfg.get("backend", "local") == "anthropic"
            else f"local:{cfg['local_endpoint']}"
        )
        reply["block"], reply["asked"] = merge_cache(
            host, block, asked, answered_by, cfg["cache_days"]
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
    USER_DIR.mkdir(parents=True, exist_ok=True)
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

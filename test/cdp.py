"""Minimal Chrome DevTools Protocol client: no third-party packages.

Worth the 80 lines because Input.dispatchKeyEvent produces *trusted* key events.
A synthetic KeyboardEvent would prove the listener runs; this proves the chord
works the way a person's keyboard does.
"""
import base64, json, os, socket, struct, time, urllib.request


class WS:
    def __init__(self, url):
        _, rest = url.split("://", 1)
        hostport, path = rest.split("/", 1)
        host, port = hostport.split(":")
        self.s = socket.create_connection((host, int(port)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n".encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
        self.id = 0
        self.events = []

    def _send(self, payload):
        data = payload.encode()
        hdr = bytearray([0x81])
        n = len(data)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
        mask = os.urandom(4)
        hdr += mask
        self.s.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _recv_frame(self):
        def need(n):
            while len(self.buf) < n:
                chunk = self.s.recv(65536)
                if not chunk:
                    raise ConnectionError("closed")
                self.buf += chunk
        need(2)
        ln = self.buf[1] & 0x7F
        off = 2
        if ln == 126:
            need(4); ln = struct.unpack(">H", self.buf[2:4])[0]; off = 4
        elif ln == 127:
            need(10); ln = struct.unpack(">Q", self.buf[2:10])[0]; off = 10
        need(off + ln)
        payload = self.buf[off:off + ln]
        self.buf = self.buf[off + ln:]
        return payload.decode("utf-8", "replace")

    def call(self, method, params=None, timeout=60):
        self.id += 1
        mid = self.id
        self._send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(self._recv_frame())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            # Keep everything else: the execution contexts we need are announced
            # as events, not returned by any call.
            if "method" in msg:
                self.events.append(msg)
        raise TimeoutError(method)

    def drain(self, seconds=1.0):
        """Collect events for a moment without issuing a call."""
        self.s.settimeout(0.3)
        end = time.time() + seconds
        try:
            while time.time() < end:
                try:
                    msg = json.loads(self._recv_frame())
                except (socket.timeout, TimeoutError, OSError):
                    continue
                if "method" in msg:
                    self.events.append(msg)
        finally:
            self.s.settimeout(30)


def attach(port=9222, match="page.html", tries=60):
    for _ in range(tries):
        try:
            targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5))
            for t in targets:
                if t.get("type") == "page" and match in t.get("url", ""):
                    return WS(t["webSocketDebuggerUrl"])
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError("no page target found")


def js(ws, expr):
    r = ws.call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
    return r.get("result", {}).get("value")


# Windows virtual key codes; Chromium wants them for non-text keys.
VK = {"Control": 17, "Alt": 18, "Delete": 46, "Escape": 27, "p": 80}


def key(ws, name, down=True, ctrl=False, alt=False):
    mods = (2 if ctrl else 0) | (1 if alt else 0)
    p = {
        "type": "keyDown" if down else "keyUp",
        "key": name,
        "windowsVirtualKeyCode": VK.get(name, 0),
        "nativeVirtualKeyCode": VK.get(name, 0),
        "modifiers": mods,
    }
    if name == "p":
        p["text"] = "p"
        p["code"] = "KeyP"
    elif name in ("Control", "Alt", "Delete", "Escape"):
        p["code"] = {"Control": "ControlLeft", "Alt": "AltLeft",
                     "Delete": "Delete", "Escape": "Escape"}[name]
    ws.call("Input.dispatchKeyEvent", p)


def mouse(ws, x, y, kind="mouseMoved", button="none"):
    ws.call("Input.dispatchMouseEvent", {
        "type": kind, "x": x, "y": y, "button": button,
        "clickCount": 1 if kind != "mouseMoved" else 0, "buttons": 0,
    })


def attach_type(port, kind, tries=60):
    """Attach to a non-page target, e.g. the extension's service worker.

    The page's main world has no chrome.storage and no runtime messaging, so
    anything that drives the extension has to run where the extension does.
    """
    for _ in range(tries):
        try:
            targets = json.load(urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json/list", timeout=5))
            for t in targets:
                if t.get("type") == kind:
                    return WS(t["webSocketDebuggerUrl"])
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError(f"no {kind} target found")


def ajs(ws, expr, timeout=60):
    """Evaluate and await a promise — the extension APIs are all async."""
    r = ws.call("Runtime.evaluate", {
        "expression": expr, "awaitPromise": True,
        "returnByValue": True, "userGesture": True,
    }, timeout=timeout)
    if "exceptionDetails" in r:
        raise RuntimeError(str(r["exceptionDetails"])[:400])
    return r.get("result", {}).get("value")


def isolated_context(ws):
    """The execution context id of the content script's world.

    A content script runs in an isolated world that has chrome.storage and
    chrome.runtime; the page's main world has neither. Driving the extension
    from a test means evaluating in that world, and the only way to learn its id
    is the executionContextCreated event.
    """
    ws.call("Runtime.enable")
    ws.drain(2.0)
    best = None
    for ev in ws.events:
        if ev.get("method") != "Runtime.executionContextCreated":
            continue
        ctx = ev["params"]["context"]
        aux = ctx.get("auxData") or {}
        if aux.get("isDefault") is False or ctx.get("name"):
            best = ctx["id"]
    return best


def cjs(ws, ctx, expr, timeout=60):
    r = ws.call("Runtime.evaluate", {
        "expression": expr, "contextId": ctx, "awaitPromise": True,
        "returnByValue": True, "userGesture": True,
    }, timeout=timeout)
    if "exceptionDetails" in r:
        raise RuntimeError(str(r["exceptionDetails"])[:300])
    return r.get("result", {}).get("value")

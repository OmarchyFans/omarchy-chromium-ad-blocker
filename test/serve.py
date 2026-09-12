"""Test server: every file in test/, a deliberately slow image, and a fake tracker."""
import http.server, pathlib, time

ROOT = pathlib.Path(__file__).parent


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0].lstrip("/") or "page.html"
        if path.startswith("slow"):
            time.sleep(6)
            return self.send(b"\x00", "image/gif")
        if path == "gpc":
            # Echo the Global Privacy Control header back to the page.
            return self.send((self.headers.get("Sec-GPC") or "none").encode(), "text/plain")
        if path.endswith("tracker.js"):
            # If this ever runs, the network rules did not block it.
            return self.send(b"document.documentElement.dataset.trackerRan='yes';",
                             "application/javascript")
        f = (ROOT / path).resolve()
        if ROOT not in f.parents or not f.is_file():
            self.send_response(404); self.end_headers(); return
        ctype = "text/html" if f.suffix == ".html" else "application/octet-stream"
        self.send(f.read_bytes(), ctype)


http.server.ThreadingHTTPServer(("127.0.0.1", 8933), H).serve_forever()

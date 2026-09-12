import http.server, time, pathlib
ROOT = pathlib.Path(__file__).parent
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith("/slow"):
            time.sleep(6)
            self.send_response(200); self.send_header("Content-Type","image/gif")
            self.send_header("Content-Length","1"); self.end_headers()
            self.wfile.write(b"\x00"); return
        body = (ROOT/"page.html").read_bytes()
        self.send_response(200); self.send_header("Content-Type","text/html")
        self.send_header("Content-Length",str(len(body))); self.end_headers()
        self.wfile.write(body)
http.server.ThreadingHTTPServer(("127.0.0.1",8933),H).serve_forever()

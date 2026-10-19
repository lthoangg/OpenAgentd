"""Serve a directory as a fake GitHub releases endpoint (tests only).

``/latest`` redirects to ``/tag/v$LATEST``, and ``/download/v$LATEST/<file>``
serves files from ``$DIR``, matching what install.sh, install.ps1 and
``agentd upgrade`` read from ``OPENAGENTD_RELEASES_URL``. The bound port
is printed on the first stdout line.
"""

import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LATEST = os.environ["LATEST"]
DIR = os.environ["DIR"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        sys.stderr.write("[releases] " + (format % args) + "\n")

    def do_GET(self):  # noqa: N802 - stdlib naming
        if self.path == "/latest":
            self.send_response(302)
            self.send_header("Location", f"/tag/v{LATEST}")
            self.end_headers()
            return
        if self.path.startswith("/tag/"):
            body = b"release page"
        else:
            prefix = f"/download/v{LATEST}/"
            name = self.path[len(prefix) :] if self.path.startswith(prefix) else ""
            path = os.path.join(DIR, name)
            if not name or "/" in name or "\\" in name or not os.path.isfile(path):
                self.send_response(404)
                self.end_headers()
                return
            with open(path, "rb") as f:
                body = f.read()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()

"""Read-only Unix-domain HTTP endpoint exposing JSON /snapshot."""

import json
import os
import socket
import socketserver
import stat
import threading
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit

from .artifacts import ArtifactError, read_prepared_artifact as read_artifact
from .errors import TransitionError, ValidationError
from .ledger import Ledger


class _UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


class _SnapshotHandler(BaseHTTPRequestHandler):
    server_version = "OrchestraSnapshot/1"
    sys_version = ""

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = parsed.path
        if path in ("/decisions", "/decisions/"):
            if not getattr(self.server, "decisions_private", False):
                self._send_json(403, {"ok": False, "error": "private_socket_required"})
                return
            query = parse_qs(parsed.query, keep_blank_values=True)
            if set(query) - {"task", "state", "waiting"} or any(len(v) != 1 for v in query.values()):
                self._send_json(400, {"ok": False, "error": "bad_request"})
                return
            try:
                payload = self.server.ledger.decisions_snapshot(
                    task_id=query.get("task", [None])[0], state=query.get("state", [None])[0],
                    waiting=query.get("waiting", [None])[0])
            except ValidationError:
                self._send_json(400, {"ok": False, "error": "bad_request"})
                return
            except Exception:
                self._send_json(500, {"ok": False, "error": "decisions_unavailable"})
                return
            self._send_json(200, payload)
            return
        if path in ("/artifact", "/artifact/"):
            query = parse_qs(parsed.query, keep_blank_values=True)
            if set(query) - {"task", "index"} or len(query.get("task", [])) != 1 or len(query.get("index", [])) != 1:
                self._send_json(400, {"ok": False, "error": "bad_request"})
                return
            try:
                payload = read_artifact(self.server.ledger, query["task"][0], query["index"][0])
            except ArtifactError:
                self._send_json(404, {"ok": False, "error": "artifact_unavailable"})
                return
            except Exception:
                self._send_json(404, {"ok": False, "error": "artifact_unavailable"})
                return
            self._send_json(200, payload)
            return
        if path in ("/snapshot", "/snapshot/"):
            try:
                payload = self.server.ledger.snapshot()
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": exc.__class__.__name__})
                return
            self._send_json(200, payload)
            return
        if path in ("/health", "/health/"):
            self._send_json(200, {"ok": True, "readOnly": True})
            return
        self._send_json(404, {"ok": False, "error": "not_found"})

    def do_HEAD(self):
        self.do_GET()

    def _read_only(self):
        self._send_json(405, {"ok": False, "error": "read_only_endpoint"})

    do_POST = _read_only
    do_PUT = _read_only
    do_PATCH = _read_only
    do_DELETE = _read_only

    def log_message(self, fmt, *args):
        # Never log request bodies; this endpoint only serves a snapshot.
        pass


def _socket_is_live(path):
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.3)
    try:
        probe.connect(path)
        return True
    except OSError:
        return False
    finally:
        probe.close()


def start_snapshot_server(state_dir, socket_path):
    """Bind a private Unix socket and serve it from a background thread."""
    absolute = os.path.abspath(os.path.expanduser(socket_path))
    parent = os.path.dirname(absolute) or "."
    if not os.path.isdir(parent):
        raise TransitionError("socket directory does not exist: %s" % parent)
    if os.path.exists(absolute):
        if not stat.S_ISSOCK(os.stat(absolute).st_mode):
            raise TransitionError(
                "socket path exists and is not a socket: %s" % absolute
            )
        if _socket_is_live(absolute):
            raise TransitionError(
                "snapshot socket is already in use: %s" % absolute
            )
        try:
            os.unlink(absolute)
        except OSError:
            pass
    server = _UnixHTTPServer(absolute, _SnapshotHandler)
    server.ledger = Ledger(state_dir)
    try:
        os.chmod(absolute, 0o600)
    except OSError:
        pass
    # The new decision endpoint fails closed if private socket permissions
    # could not be established. Keep the existing snapshot behavior intact.
    try:
        socket_stat = os.stat(absolute)
        parent_stat = os.stat(parent)
        server.decisions_private = (
            socket_stat.st_uid == os.getuid() and stat.S_IMODE(socket_stat.st_mode) == 0o600
            and parent_stat.st_uid == os.getuid() and stat.S_IMODE(parent_stat.st_mode) == 0o700
        )
    except OSError:
        server.decisions_private = False
    thread = threading.Thread(
        target=server.serve_forever,
        kwargs={"poll_interval": 0.2},
        name="orchestra-snapshot",
        daemon=True,
    )
    thread.start()
    return server


def stop_snapshot_server(server):
    if server is None:
        return
    try:
        server.shutdown()
    except Exception:
        pass
    try:
        server.server_close()
    except Exception:
        pass
    path = server.server_address
    if isinstance(path, str) and os.path.exists(path):
        try:
            os.unlink(path)
        except OSError:
            pass

"""Singleton daemon lifecycle: flock, pid file, collector, Unix snapshot server."""

import fcntl
import json
import os
import signal
import sys
import threading

from .archive import NativeArchiveClient, run_archive
from .collector import Collector
from .constants import BRIDGE_SOCKET, POLL_INTERVAL_SECONDS, WORKER_COUNT
from .errors import TransitionError
from .ledger import Ledger
from .server import start_snapshot_server, stop_snapshot_server
from .util import now_iso


class SingletonLock:
    def __init__(self, state_dir):
        self.path = os.path.join(state_dir, "daemon.lock")
        self.fd = None

    def acquire(self):
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            raise TransitionError(
                "another orchestra daemon already holds %s" % self.path
            )
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode("ascii"))
        os.fsync(fd)
        self.fd = fd
        return self

    def release(self):
        if self.fd is not None:
            try:
                os.close(self.fd)
            finally:
                self.fd = None


def run_daemon(
    state_dir,
    socket_path,
    bridge_socket=BRIDGE_SOCKET,
    interval=POLL_INTERVAL_SECONDS,
    workers=WORKER_COUNT,
    enable_archive_run=False,
):
    ledger = Ledger(state_dir)
    lock = SingletonLock(ledger.state_dir).acquire()
    pid_path = os.path.join(ledger.state_dir, "daemon.pid")
    stop_event = threading.Event()
    server = None
    archive_worker = None
    ledger.set_meta("archive_run_enabled", "1" if enable_archive_run else "0")

    def _archive_loop():
        client = NativeArchiveClient(socket_path=bridge_socket)
        while not stop_event.wait(2.0):
            try:
                pending = ledger.pending_archive_requests(limit=10)
            except Exception as exc:
                ledger.set_meta(
                    "collector_error",
                    "archive queue query failed: %s" % exc.__class__.__name__,
                )
                continue
            for item in pending:
                if stop_event.is_set():
                    break
                try:
                    run_archive(
                        ledger,
                        item["task"]["id"],
                        item["opId"],
                        client=client,
                    )
                except Exception as exc:
                    ledger.set_meta(
                        "collector_error",
                        "archive-run %s failed: %s"
                        % (item["task"]["id"], exc.__class__.__name__),
                    )

    def _write_pid():
        tmp = pid_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "pid": os.getpid(),
                    "startedAt": now_iso(),
                    "socket": os.path.abspath(socket_path),
                    "bridgeSocket": bridge_socket,
                },
                handle,
            )
        os.chmod(tmp, 0o600)
        os.replace(tmp, pid_path)

    def _handle_signal(signum, frame):
        stop_event.set()

    previous = {}
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            previous[sig] = signal.signal(sig, _handle_signal)
        except (ValueError, OSError):
            pass

    try:
        _write_pid()
        server = start_snapshot_server(ledger.state_dir, socket_path)
        collector = Collector(
            ledger,
            socket_path=bridge_socket,
            interval=interval,
            workers=workers,
        )
        if enable_archive_run:
            archive_worker = threading.Thread(
                target=_archive_loop,
                name="orchestra-archive",
                daemon=True,
            )
            archive_worker.start()
        print(
            json.dumps(
                {
                    "ok": True,
                    "pid": os.getpid(),
                    "state": ledger.state_dir,
                    "socket": os.path.abspath(socket_path),
                    "bridgeSocket": bridge_socket,
                    "pollIntervalSeconds": interval,
                    "workerCount": workers,
                    "archiveRunEnabled": bool(enable_archive_run),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        collector.run(stop_event)
    finally:
        if archive_worker is not None:
            archive_worker.join(timeout=3.0)
        if server is not None:
            stop_snapshot_server(server)
        ledger.set_meta("daemon_pid", "")
        try:
            os.unlink(pid_path)
        except OSError:
            pass
        lock.release()
        for sig, handler in previous.items():
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):
                pass
        print("orchestra: daemon stopped", file=sys.stderr, flush=True)

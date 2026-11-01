"""Command-line entry points for the local Codex Orchestra backend."""

import argparse
import json
import sys

from . import __version__
from .archive import NativeArchiveClient, run_archive
from .collector import Collector
from .constants import BRIDGE_SOCKET, POLL_INTERVAL_SECONDS, WORKER_COUNT
from .daemon import run_daemon
from .errors import OrchestraError
from .ledger import Ledger
from .util import read_json_file


def _emit(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _parser():
    parser = argparse.ArgumentParser(
        prog="orchestra.py",
        description="Local Codex Orchestra task ledger and read-only snapshot daemon.",
    )
    parser.add_argument("--state", required=True, help="private state directory")
    parser.add_argument("--version", action="version", version="orchestra %s" % __version__)
    sub = parser.add_subparsers(dest="command", required=True)

    register = sub.add_parser("register", help="register a task from a JSON file")
    register.add_argument("--json", required=True, dest="json_path")

    importer = sub.add_parser("import-markdown", help="import the controller task overview markdown")
    importer.add_argument("file")

    update_contract = sub.add_parser(
        "update-contract", help="amend contract text without changing identity/state"
    )
    update_contract.add_argument("task")
    update_contract.add_argument("--json", required=True, dest="json_path")

    dispatch = sub.add_parser("dispatch-intent", help="persist a dispatch intent (no native create)")
    dispatch.add_argument("task")
    dispatch.add_argument("--op-id", required=True, dest="op_id")

    pending = sub.add_parser(
        "dispatch-pending", help="persist a pending create clientThreadId for restart reconcile"
    )
    pending.add_argument("task")
    pending.add_argument("--op-id", required=True, dest="op_id")
    pending.add_argument("--client-thread", required=True, dest="client_thread")

    bind = sub.add_parser("bind", help="record the real native create receipt")
    bind.add_argument("task")
    bind.add_argument("--op-id", required=True, dest="op_id")
    bind.add_argument("--thread", required=True)
    bind.add_argument("--host", default="local")

    observe = sub.add_parser("observe-once", help="one bounded parallel observation pass")
    observe.add_argument("--socket", default=BRIDGE_SOCKET, dest="bridge_socket")

    sub.add_parser("snapshot", help="print the JSON snapshot")

    export = sub.add_parser("export-md", help="write an explicit derived markdown file")
    export.add_argument("file")
    export.add_argument("--force", action="store_true")

    review = sub.add_parser("review", help="record acceptance or rejection")
    review.add_argument("task")
    review.add_argument("--result", required=True, choices=("accepted", "rejected"))
    review.add_argument("--evidence", required=True)
    review.add_argument("--op-id", required=True, dest="op_id")

    archive = sub.add_parser("archive-request", help="request archive (native action stays external)")
    archive.add_argument("task")
    archive.add_argument("--op-id", required=True, dest="op_id")

    receipt = sub.add_parser("archive-receipt", help="record a native archive result")
    receipt.add_argument("task")
    receipt.add_argument("--op-id", required=True, dest="op_id")
    receipt.add_argument(
        "--result", required=True, choices=("confirmed", "failed", "unknown")
    )
    receipt.add_argument("--evidence", required=True)

    archive_run = sub.add_parser(
        "archive-run", help="safely execute one explicitly requested native archive"
    )
    archive_run.add_argument("task")
    archive_run.add_argument("--op-id", required=True, dest="op_id")
    archive_run.add_argument("--socket", default=BRIDGE_SOCKET, dest="bridge_socket")
    archive_run.add_argument("--max-pages", type=int, default=50, dest="max_pages")

    sub.add_parser("consume", help="list unacknowledged delivery/blocked notices")

    ack = sub.add_parser("ack", help="acknowledge one notice")
    ack.add_argument("notice_id")

    serve = sub.add_parser("serve", help="run the singleton polling daemon and Unix snapshot server")
    serve.add_argument("--socket", required=True)
    serve.add_argument("--bridge-socket", default=BRIDGE_SOCKET, dest="bridge_socket")
    serve.add_argument("--interval", type=float, default=POLL_INTERVAL_SECONDS)
    serve.add_argument("--workers", type=int, default=WORKER_COUNT)
    serve.add_argument(
        "--enable-archive-run",
        action="store_true",
        dest="enable_archive_run",
        help="opt in to executing explicitly requested pending archive ops",
    )
    serve.add_argument("--state-dir", default=None, dest="state_dir_override")
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    try:
        ledger = Ledger(args.state)
        if args.command == "register":
            payload = read_json_file(args.json_path)
            _emit(ledger.register(payload))
        elif args.command == "import-markdown":
            _emit(ledger.import_markdown(args.file))
        elif args.command == "update-contract":
            _emit(ledger.update_contract(args.task, read_json_file(args.json_path)))
        elif args.command == "dispatch-intent":
            _emit(ledger.dispatch_intent(args.task, args.op_id))
        elif args.command == "dispatch-pending":
            _emit(
                ledger.dispatch_pending(args.task, args.op_id, args.client_thread)
            )
        elif args.command == "bind":
            _emit(ledger.bind(args.task, args.op_id, args.thread, args.host))
        elif args.command == "observe-once":
            collector = Collector(ledger, socket_path=args.bridge_socket)
            try:
                _emit(collector.observe_all())
            finally:
                collector.close()
        elif args.command == "snapshot":
            _emit(ledger.snapshot())
        elif args.command == "export-md":
            path = ledger.export_markdown(args.file, force=args.force)
            _emit({"ok": True, "path": path})
        elif args.command == "review":
            _emit(ledger.review(args.task, args.result, args.evidence, args.op_id))
        elif args.command == "archive-request":
            _emit(ledger.archive_request(args.task, args.op_id))
        elif args.command == "archive-receipt":
            _emit(
                ledger.archive_receipt(
                    args.task, args.op_id, args.result, args.evidence
                )
            )
        elif args.command == "archive-run":
            client = NativeArchiveClient(
                socket_path=args.bridge_socket, max_pages=args.max_pages
            )
            _emit(
                run_archive(
                    ledger,
                    args.task,
                    args.op_id,
                    client=client,
                    max_pages=args.max_pages,
                )
            )
        elif args.command == "consume":
            _emit(ledger.consume_notices())
        elif args.command == "ack":
            _emit(ledger.ack_notice(args.notice_id))
        elif args.command == "serve":
            state = args.state
            if args.state_dir_override:
                state = args.state_dir_override
            run_daemon(
                state,
                args.socket,
                bridge_socket=args.bridge_socket,
                interval=args.interval,
                workers=args.workers,
                enable_archive_run=args.enable_archive_run,
            )
        else:  # pragma: no cover - argparse enforces choices
            raise OrchestraError("unknown command")
        return 0
    except OrchestraError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    except (OSError, ValueError) as exc:
        print(
            json.dumps(
                {"ok": False, "error": "%s: %s" % (exc.__class__.__name__, exc)},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())

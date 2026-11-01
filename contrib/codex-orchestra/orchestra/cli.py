"""Command-line entry points for the local Codex Orchestra backend."""

import argparse
import json
import sys

from . import __version__
from .archive import NativeArchiveClient, run_archive
from .collector import Collector
from .artifacts import prepare_artifact
from .brief import write_brief
from .context import context_packet
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

    adopt = sub.add_parser("adopt", help="explicitly adopt an authorized external identity; no native message/create")
    adopt.add_argument("task")
    adopt.add_argument("--json", dest="json_file", required=True)
    adopt.add_argument("--op-id", required=True)

    session = sub.add_parser("add-session", help="associate an explicit additional role session; no native create")
    session.add_argument("task")
    session.add_argument("--json", dest="json_file", required=True)
    session.add_argument("--op-id", required=True)

    session_review = sub.add_parser("session-review", help="record acceptance/rejection for one associated session")
    session_review.add_argument("task")
    session_review.add_argument("session_id")
    session_review.add_argument("--result", required=True, choices=("accepted", "rejected"))
    session_review.add_argument("--evidence", required=True)
    session_review.add_argument("--op-id", required=True)

    end_session = sub.add_parser("end-session", help="mark an associated session responsibility ended")
    end_session.add_argument("task")
    end_session.add_argument("session_id")
    end_session.add_argument("--op-id", required=True)

    prepare = sub.add_parser("prepare-artifact", help="prepare an explicitly registered Markdown report for private web reading")
    prepare.add_argument("task")
    prepare.add_argument("--index", type=int, default=0)

    brief = sub.add_parser("brief", help="save an explicit controller brief separately from native progress")
    brief.add_argument("task")
    brief.add_argument("--text", required=True)
    brief.add_argument("--as-of", dest="as_of")

    context = sub.add_parser("context", help="read a task-scoped bounded handoff packet; no model/native mutations")
    context.add_argument("task")
    mode = context.add_mutually_exclusive_group()
    mode.add_argument("--full", action="store_true", help="recall the full recorded contract explicitly")
    mode.add_argument("--ref", dest="reference", help="recall an exact reference value from the packet")
    context.add_argument("--revision", help="reject a reference recall if the recorded contract has changed")

    history = sub.add_parser("history", help="recall full per-task review/contract history on demand")
    history.add_argument("task")
    history.add_argument("--limit", type=int, default=20)
    history.add_argument("--before", help="exclusive ISO timestamp bound for older events")

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
        elif args.command == "adopt":
            _emit(ledger.adopt_external(args.task, read_json_file(args.json_file), args.op_id))
        elif args.command == "add-session":
            _emit(ledger.add_task_session(args.task, read_json_file(args.json_file), args.op_id))
        elif args.command == "session-review":
            _emit(ledger.review_session(args.task, args.session_id, args.result, args.evidence, args.op_id))
        elif args.command == "end-session":
            _emit(ledger.end_task_session(args.task, args.session_id, args.op_id))
        elif args.command == "prepare-artifact":
            _emit(prepare_artifact(ledger, args.task, args.index))
        elif args.command == "brief":
            _emit(write_brief(ledger, args.task, args.text, args.as_of))
        elif args.command == "context":
            _emit(context_packet(ledger, args.task, full=args.full, reference=args.reference, revision=args.revision))
        elif args.command == "history":
            _emit({"taskId": args.task, "events": ledger.task_history(args.task, limit=args.limit, before=args.before)})
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

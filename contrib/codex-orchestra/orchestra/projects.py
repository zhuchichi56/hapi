"""Explicit project metadata sidecar; independent of the ledger and main CLI."""

import argparse
import copy
import fcntl
import json
import math
import os
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

CATALOG_FILE = "project-catalog.json"
LOCK_FILE = ".project-catalog.lock"
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_WIRE_BYTES = 256 * 1024


class CatalogError(ValueError):
    """Invalid explicit metadata; messages contain no private field values."""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def normalize_time(value):
    if value is None or value == "":
        return None
    try:
        if isinstance(value, bool):
            raise ValueError()
        if isinstance(value, (int, float)) or (
            isinstance(value, str) and value.strip().replace(".", "", 1).isdigit()
        ):
            stamp = float(value)
            if not math.isfinite(stamp):
                raise ValueError()
            if abs(stamp) >= 100_000_000_000:
                stamp /= 1000
            parsed = datetime.fromtimestamp(stamp, timezone.utc)
        else:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds")
    except (ValueError, TypeError, AttributeError, OverflowError, OSError):
        raise CatalogError("invalid_timestamp") from None


def _string(value, limit=256, required=True):
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > limit:
        raise CatalogError("invalid_text_field")
    return value


def empty_catalog():
    return {"version": 1, "asOf": None, "projects": [], "assignments": {},
            "taskAssignments": {}, "taskPresentations": {}, "threads": []}


def default_projects():
    taxonomy = [
        ("urbanclaw", "UrbanClaw", [("tob", "ToB"), ("toc", "ToC"), ("planning", "城市规划图"), ("blog", "技术博客")]),
        ("learning-deployment", "Learning from Deployment", [("general", "通用")]),
        ("deepswe", "DeepSWE", [("evaluation", "评测"), ("rsi", "RSI"), ("serving", "推理部署与测速")]),
        ("personal-agent", "Personal Agent", [("private", "私人看板"), ("opensource", "开源版")]),
        ("devtools", "开发工具", [("hapi", "HAPI"), ("orchestra", "总控界面")]),
        ("misc", "杂项", [("general", "未分类")]),
    ]
    return [{"id": pid, "name": name, "directions": [{"id": did, "name": label} for did, label in directions]}
            for pid, name, directions in taxonomy]


def validate_catalog(raw):
    if not isinstance(raw, dict) or type(raw.get("version")) is not int or raw["version"] != 1:
        raise CatalogError("invalid_catalog_version")
    result = copy.deepcopy(raw)
    for key, default in empty_catalog().items():
        result.setdefault(key, default)
    result["asOf"] = normalize_time(result["asOf"])
    if not isinstance(result["projects"], list) or not isinstance(result["threads"], list):
        raise CatalogError("invalid_catalog_lists")
    projects = {}
    for project in result["projects"]:
        if not isinstance(project, dict):
            raise CatalogError("invalid_project")
        pid = _string(project.get("id"))
        _string(project.get("name"), 512)
        if pid in projects or not isinstance(project.get("directions"), list):
            raise CatalogError("invalid_project_directions")
        directions = set()
        for direction in project["directions"]:
            if not isinstance(direction, dict):
                raise CatalogError("invalid_direction")
            did = _string(direction.get("id"))
            _string(direction.get("name"), 512)
            if did in directions:
                raise CatalogError("duplicate_direction")
            directions.add(did)
        parents = {direction["id"]: direction.get("parentId") for direction in project["directions"]}
        for did, parent in parents.items():
            visited = {did}
            while parent is not None:
                if parent not in directions or parent in visited:
                    raise CatalogError("invalid_direction_parent")
                visited.add(parent)
                parent = parents[parent]
        projects[pid] = directions
    for key in ("assignments", "taskAssignments"):
        if not isinstance(result[key], dict):
            raise CatalogError("invalid_assignments")
        for identity, assignment in result[key].items():
            _string(identity)
            _validate_assignment(assignment, projects)
    if not isinstance(result["taskPresentations"], dict):
        raise CatalogError("invalid_presentations")
    for identity, value in result["taskPresentations"].items():
        _string(identity)
        if not isinstance(value, dict):
            raise CatalogError("invalid_presentation")
        for key in ("title", "delivery", "summary", "nextStep", "phaseEvidence"):
            if key in value:
                _string(value[key], 4096, required=False)
        for key in ("summaryAt", "phaseAt"):
            if key in value:
                value[key] = normalize_time(value[key])
        if value.get("phaseState") not in (None, "blocked", "ended"):
            raise CatalogError("invalid_presentation_phase")
    seen = set()
    for thread in result["threads"]:
        if not isinstance(thread, dict):
            raise CatalogError("invalid_thread")
        tid = _string(thread.get("id"))
        if tid in seen:
            raise CatalogError("duplicate_thread")
        seen.add(tid)
        _string(thread.get("title"), 8192, required=False)
        _string(thread.get("source"), 1024)
        if type(thread.get("archived")) is not bool:
            raise CatalogError("invalid_native_archive")
        thread["updatedAt"] = normalize_time(thread.get("updatedAt"))
        if "projectId" in thread:
            if _string(thread["projectId"]) not in projects:
                raise CatalogError("unknown_thread_project")
        for key in ("cwd", "summary"):
            if key in thread:
                _string(thread[key], MAX_FILE_BYTES, required=False)
    return result


def _validate_assignment(value, projects):
    if not isinstance(value, dict):
        raise CatalogError("invalid_assignment")
    pid = _string(value.get("projectId"))
    did = _string(value.get("directionId"))
    _string(value.get("evidence"), 8192)
    if pid not in projects or did not in projects[pid]:
        raise CatalogError("unknown_assignment_direction")


def _read_json(path, missing=False):
    try:
        with open(path, "rb") as handle:
            data = handle.read(MAX_FILE_BYTES + 1)
    except FileNotFoundError:
        if missing:
            return empty_catalog()
        raise CatalogError("file_missing") from None
    except OSError:
        raise CatalogError("file_unreadable") from None
    if len(data) > MAX_FILE_BYTES:
        raise CatalogError("catalog_file_too_large")
    def reject_constant(_value):
        raise CatalogError("invalid_json_constant")
    try:
        return json.loads(data, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise CatalogError("invalid_json") from None


def read_catalog(state):
    return validate_catalog(_read_json(Path(state).expanduser() / CATALOG_FILE, missing=True))


@contextmanager
def _locked(state):
    root = Path(state).expanduser().absolute()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Never chmod or rewrite existing private state directory/ledger files.
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(root / LOCK_FILE, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield root
    finally:
        os.close(fd)


def _save(root, catalog):
    catalog = validate_catalog(catalog)
    data = json.dumps(catalog, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8") + b"\n"
    if len(data) > MAX_FILE_BYTES:
        raise CatalogError("catalog_file_too_large")
    fd, temporary = tempfile.mkstemp(prefix=".project-catalog-", dir=root)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, root / CATALOG_FILE)
        directory_fd = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _merge_records(existing, incoming):
    if not isinstance(incoming, list) or any(not isinstance(item, dict) for item in incoming):
        raise CatalogError("invalid_import_records")
    records = {item["id"]: copy.deepcopy(item) for item in existing}
    for item in incoming:
        identity = _string(item.get("id"))
        old = records.get(identity, {})
        merged = {**old, **copy.deepcopy(item)}
        if "directions" in item:
            merged["directions"] = _merge_records(old.get("directions", []), item["directions"])
        if "source" in item:
            sources = copy.deepcopy(old.get("_sources", []))
            if not isinstance(sources, list):
                raise CatalogError("invalid_import_sources")
            for source in (old.get("source"), item["source"]):
                if source is not None and source not in sources:
                    sources.append(source)
            merged["_sources"] = sources
        records[identity] = merged
    return list(records.values())


def merge_explicit(catalog, incoming):
    """Import only explicit metadata; keep manual assignments and all evidence."""
    if not isinstance(incoming, dict) or type(incoming.get("version", 1)) is not int or incoming.get("version", 1) != 1:
        raise CatalogError("invalid_import")
    result = copy.deepcopy(catalog)
    for key in ("projects", "threads"):
        result[key] = _merge_records(result[key], incoming.get(key, []))
    result = validate_catalog(result)
    taxonomy = {p["id"]: {d["id"] for d in p["directions"]} for p in result["projects"]}
    for key in ("assignments", "taskAssignments"):
        values = incoming.get(key, {})
        if not isinstance(values, dict):
            raise CatalogError("invalid_import_assignments")
        for identity, value in values.items():
            _string(identity)
            if not isinstance(value, dict):
                raise CatalogError("invalid_assignment")
            _validate_assignment(value, taxonomy)
            old = result[key].get(identity, {})
            history = copy.deepcopy(old.get("_importEvidence", []))
            if not isinstance(history, list):
                raise CatalogError("invalid_import_evidence")
            if old:
                previous = {k: old.get(k) for k in ("projectId", "directionId", "evidence")}
                if previous not in history:
                    history.append(previous)
            evidence = {k: value.get(k) for k in ("projectId", "directionId", "evidence")}
            if evidence not in history:
                history.append(evidence)
            if old.get("_manual"):
                merged = copy.deepcopy(old)
            else:
                merged = {**old, **copy.deepcopy(value)}
                merged.pop("_manual", None)
            merged["_importEvidence"] = history
            result[key][identity] = merged
    values = incoming.get("taskPresentations", {})
    if not isinstance(values, dict):
        raise CatalogError("invalid_presentations")
    for identity, value in values.items():
        _string(identity)
        if not isinstance(value, dict):
            raise CatalogError("invalid_presentation")
        result["taskPresentations"][identity] = {**result["taskPresentations"].get(identity, {}), **copy.deepcopy(value)}
    # Do not let an index's unknown top-level fields overwrite private settings.
    return validate_catalog(result)


def _assignment_wire(value):
    return {"projectId": value["projectId"], "directionId": value["directionId"], "evidence": value["evidence"][:256]}


def catalog_wire(state):
    catalog = read_catalog(state)
    wire = {"version": 1, "asOf": catalog["asOf"],
            "coverage": {"indexed": len(catalog["threads"]), "emitted": 0, "truncated": False},
            "projects": [{"id": p["id"], "name": p["name"],
                          "directions": [{"id": d["id"], "name": d["name"], **({"parentId": d["parentId"]} if d.get("parentId") else {})} for d in p["directions"]]} for p in catalog["projects"]],
            "assignments": {k: _assignment_wire(v) for k, v in catalog["assignments"].items()},
            "taskAssignments": {k: _assignment_wire(v) for k, v in catalog["taskAssignments"].items()},
            "threads": []}
    for thread in catalog["threads"]:
        item = {key: thread[key] for key in ("id", "updatedAt", "archived")}
        item.update(title=thread["title"][:240], source=thread["source"][:120])
        for key, limit in (("projectId", 256), ("cwd", 160), ("summary", 320)):
            if key in thread:
                item[key] = thread[key][:limit]
        if any(len(thread.get(key, "")) > limit for key, limit in (("title", 240), ("source", 120), ("cwd", 160), ("summary", 320))):
            wire["coverage"]["truncated"] = True
        wire["threads"].append(item)
    if any(len(value["evidence"]) > 256 for key in ("assignments", "taskAssignments") for value in catalog[key].values()):
        wire["coverage"]["truncated"] = True
    wire["coverage"]["emitted"] = len(wire["threads"])
    def size():
        # Match the server's default separators, not a smaller compact encoding.
        return len(json.dumps(wire, ensure_ascii=False).encode("utf-8"))
    if size() > MAX_WIRE_BYTES:
        for item in wire["threads"]:
            item.pop("cwd", None)
            item.pop("summary", None)
        wire["coverage"]["truncated"] = True
    while size() > MAX_WIRE_BYTES and wire["threads"]:
        wire["threads"].pop()
        wire["coverage"]["emitted"] = len(wire["threads"])
        wire["coverage"]["truncated"] = True
    wire["coverage"]["emitted"] = len(wire["threads"])
    if size() > MAX_WIRE_BYTES:
        raise CatalogError("catalog_wire_too_large")
    return wire


def attach_project_catalog(payload, state):
    """Return a new snapshot; catalog failures never hide original tasks."""
    result = dict(payload)
    result.pop("projectCatalogError", None)
    try:
        result["projectCatalog"] = catalog_wire(state)
        catalog = read_catalog(state)
        presentations = catalog["taskPresentations"]
        if presentations:
            result["tasks"] = [{**task, **({"presentation": {
            key: value for key, value in presentations[task["id"]].items()
            if key in ("title", "delivery", "summary", "summaryAt", "nextStep", "phaseState", "phaseAt", "phaseEvidence")
            }} if task.get("id") in presentations else {})} for task in payload.get("tasks", [])]
            for task in result["tasks"]:
                presentation = task.get("presentation")
                if not presentation or not task.get("briefAsOf") or not presentation.get("summaryAt"):
                    continue
                try:
                    if normalize_time(task["briefAsOf"]) > normalize_time(presentation["summaryAt"]):
                        presentation.pop("summary", None)
                        presentation.pop("summaryAt", None)
                except CatalogError:
                    pass
        archived = {thread["id"] for thread in catalog["threads"] if thread["archived"]}
        if archived:
            result["tasks"] = [{**task, "sessions": [
                {**session, "nativeArchived": True} if session.get("threadId") in archived else session
                for session in task.get("sessions", [])
            ]} for task in result.get("tasks", [])]
    except (CatalogError, OSError, UnicodeError, RecursionError):
        result["projectCatalog"] = {**empty_catalog(), "coverage": {"indexed": 0, "emitted": 0, "truncated": False}}
        result["projectCatalogError"] = "catalog_unavailable_or_invalid"
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, help="private sidecar directory")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init")
    catalog_parser = commands.add_parser("catalog")
    catalog_parser.add_argument("--json", dest="json_file", help="merge explicit projects and metadata")
    importer = commands.add_parser("import-index")
    importer.add_argument("files", nargs="+")
    for command, identity in (("assign", "thread"), ("assign-task", "task")):
        assign = commands.add_parser(command)
        assign.add_argument("--" + identity, required=True)
        assign.add_argument("--project", required=True)
        assign.add_argument("--direction", required=True)
        assign.add_argument("--evidence", required=True)
    batch = commands.add_parser("apply")
    batch.add_argument("--json", dest="json_file", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "catalog" and not args.json_file:
            print(json.dumps(read_catalog(args.state), ensure_ascii=False, indent=2))
            return 0
        with _locked(args.state) as root:
            catalog = read_catalog(root)
            before = copy.deepcopy(catalog)
            if args.command == "init":
                catalog["projects"] = _merge_records(default_projects(), catalog["projects"])
            elif args.command in ("catalog", "import-index"):
                paths = args.files if args.command == "import-index" else [args.json_file]
                for path in paths:
                    catalog = merge_explicit(catalog, _read_json(path))
            else:
                if args.command == "apply":
                    changes = _read_json(args.json_file)
                    if not isinstance(changes, dict) or set(changes) - {"assignments", "taskAssignments"}:
                        raise CatalogError("invalid_batch_assignments")
                else:
                    key = "assignments" if args.command == "assign" else "taskAssignments"
                    identity = args.thread if args.command == "assign" else args.task
                    changes = {key: {identity: {"projectId": args.project, "directionId": args.direction, "evidence": args.evidence}}}
                for key, values in changes.items():
                    if not isinstance(values, dict):
                        raise CatalogError("invalid_batch_assignments")
                    for identity, value in values.items():
                        _string(identity)
                        if not isinstance(value, dict):
                            raise CatalogError("invalid_assignment")
                        catalog[key][identity] = {**catalog[key].get(identity, {}), **value, "_manual": True}
            catalog = validate_catalog(catalog)
            if catalog != before or not (root / CATALOG_FILE).exists():
                catalog["asOf"] = now_iso()
                _save(root, catalog)
        print(json.dumps({"ok": True, "projects": len(catalog["projects"]), "threads": len(catalog["threads"])}))
        return 0
    except (CatalogError, OSError, UnicodeError, RecursionError) as exc:
        # Do not echo paths, identities, evidence, or filesystem exception text.
        error = str(exc) if isinstance(exc, CatalogError) else "catalog_io_error"
        print(json.dumps({"ok": False, "error": error}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

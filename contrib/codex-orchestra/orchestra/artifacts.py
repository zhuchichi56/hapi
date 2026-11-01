"""Resolve one registered deliverable to a bounded UTF-8 Markdown/text file.

Only paths registered in ``task.deliverables[index]`` are read, and only under
the import source's parent directory plus explicit ``meta.artifact_roots``.
No path is guessed: a missing or ambiguous target is an error.
"""

import json
import os
import re

MAX_BYTES = 256 * 1024
ALLOWED_SUFFIXES = (".md", ".markdown", ".txt")
TASK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LINK_RE = re.compile(
    r"\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[\"'][^\"']*[\"'])?\s*\)"
)
SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


class ArtifactError(Exception):
    """A deliberately terse error; the HTTP layer maps it to a generic code."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _roots(ledger):
    roots = []
    source = ledger.get_meta("import_source")
    if isinstance(source, str) and source.strip():
        roots.append(os.path.dirname(os.path.abspath(os.path.expanduser(source.strip()))))
    raw = ledger.get_meta("artifact_roots")
    if raw:
        try:
            data = json.loads(raw) if isinstance(raw, str) else raw
        except (TypeError, ValueError):
            data = None
        if isinstance(data, str):
            data = [data]
        if isinstance(data, list):
            for item in data:
                if isinstance(item, str) and os.path.isabs(os.path.expanduser(item)):
                    roots.append(os.path.abspath(os.path.expanduser(item)))
    unique = []
    for root in roots:
        if root not in unique:
            unique.append(root)
    return tuple(unique)


def _deliverable_target(value):
    text = value.strip()
    if not text:
        raise ArtifactError("artifact_unavailable")
    link = LINK_RE.search(text)
    if link:
        name = link.group(1).strip()
        target = (link.group(2) or link.group(3) or "").strip()
    else:
        target = text.strip("`'\"")
        target = target.rstrip("。；;，, \t")
        name = ""
    if not target or target.startswith("#"):
        raise ArtifactError("artifact_unavailable")
    if "\x00" in target or "\n" in target or "\r" in target or "\\" in target:
        raise ArtifactError("artifact_unavailable")
    if target.startswith("//") or SCHEME_RE.match(target):
        raise ArtifactError("artifact_unavailable")
    return name, target


def _inside(path, root):
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def _resolve(roots, target):
    expanded = os.path.expanduser(target)
    candidates = []
    if os.path.isabs(expanded):
        candidates.append(expanded)
    else:
        candidates.extend(os.path.join(root, expanded) for root in roots)
    found = []
    for candidate in candidates:
        real = os.path.realpath(candidate)
        if not any(_inside(real, os.path.realpath(root)) for root in roots):
            continue
        if os.path.isfile(real):
            found.append(real)
    if not found:
        raise ArtifactError("artifact_unavailable")
    if len(set(found)) > 1:
        raise ArtifactError("artifact_unavailable")
    return found[0]


def read_artifact(ledger, task_id, index):
    """Return ``{name, content}`` for the exactly registered deliverable."""
    if not isinstance(task_id, str) or not TASK_ID_RE.match(task_id.strip()):
        raise ArtifactError("artifact_unavailable")
    task_id = task_id.strip()
    if isinstance(index, bool):
        raise ArtifactError("artifact_unavailable")
    try:
        index = int(index)
    except (TypeError, ValueError):
        raise ArtifactError("artifact_unavailable")
    if index < 0:
        raise ArtifactError("artifact_unavailable")

    task = ledger.get_task(task_id)
    if not task:
        raise ArtifactError("artifact_unavailable")
    deliverables = task.get("deliverables")
    if not isinstance(deliverables, list) or index >= len(deliverables):
        raise ArtifactError("artifact_unavailable")
    value = deliverables[index]
    if not isinstance(value, str) or not value.strip():
        raise ArtifactError("artifact_unavailable")

    label, target = _deliverable_target(value)
    roots = _roots(ledger)
    if not roots:
        raise ArtifactError("artifact_unavailable")
    path = _resolve(roots, target)
    if os.path.splitext(path)[1].lower() not in ALLOWED_SUFFIXES:
        raise ArtifactError("artifact_unavailable")
    size = os.path.getsize(path)
    if size > MAX_BYTES:
        raise ArtifactError("artifact_unavailable")
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_BYTES + 1)
    except OSError:
        raise ArtifactError("artifact_unavailable")
    if len(raw) > MAX_BYTES:
        raise ArtifactError("artifact_unavailable")
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ArtifactError("artifact_unavailable")
    name = (label or os.path.basename(path)).strip()[:200] or "artifact"
    return {"name": name, "content": content}


def _prepared_path(ledger, task_id, index):
    import hashlib
    key = hashlib.sha256((str(task_id) + ':' + str(index)).encode()).hexdigest()
    return os.path.join(ledger.state_dir, 'prepared-artifacts', key + '.json')


def prepare_artifact(ledger, task_id, index):
    import hashlib
    from .util import atomic_write, now_iso
    payload = read_artifact(ledger, task_id, index)
    task = ledger.get_task(task_id)
    registered = task['deliverables'][int(index)]
    payload['registeredHash'] = hashlib.sha256(registered.encode()).hexdigest()
    payload['preparedAt'] = now_iso()
    path = _prepared_path(ledger, task_id, index)
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    atomic_write(path, json.dumps(payload, ensure_ascii=False))
    return {'taskId': task_id, 'index': int(index), 'name': payload['name'], 'preparedAt': payload['preparedAt']}


def read_prepared_artifact(ledger, task_id, index):
    import hashlib
    if not TASK_ID_RE.fullmatch(str(task_id)) or not str(index).isdigit():
        raise ArtifactError('artifact_unavailable')
    task = ledger.get_task(task_id)
    index = int(index)
    if not task or index >= len(task['deliverables']):
        raise ArtifactError('artifact_unavailable')
    try:
        with open(_prepared_path(ledger, task_id, index), encoding='utf-8') as handle:
            payload = json.loads(handle.read(MAX_BYTES * 6 + 2048))
    except (OSError, ValueError):
        raise ArtifactError('artifact_unavailable')
    expected = hashlib.sha256(task['deliverables'][index].encode()).hexdigest()
    if payload.get('registeredHash') != expected or not isinstance(payload.get('content'), str) or len(payload['content'].encode()) > MAX_BYTES:
        raise ArtifactError('artifact_unavailable')
    return {'name': payload['name'], 'content': payload['content'], 'preparedAt': payload['preparedAt']}

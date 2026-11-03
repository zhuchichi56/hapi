"""Compact durable dispatch on operations; external CLI candidates, no native I/O.

Submit is SQLite-only. A collector tick monitors before claiming one launch.
Intent is FULL-sync before Popen. Claimed/uncertain operations are NEVER replayed.
"""

import json
import math
import os
from pathlib import Path
import re
import subprocess
import uuid
from datetime import datetime

from .constants import CONTROLLER_THREAD_ID
from .errors import NotFoundError, TransitionError, ValidationError
from .receipts import encoded, ident, text
from .util import atomic_write, parse_iso

KIND = 'silent_dispatch'
ACTIVE = ('launching', 'running', 'reconciliation-needed')
TERMINAL = ('completed', 'failed')
MAX_ACTIVE = 2
MAX_OUTSTANDING = 100
REQUEST_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}')
LAUNCHER = '/Users/zhuhe/.codex/skills/dsh-delegate/scripts/delegate_run.sh'
PINNED = [LAUNCHER, '--executor', 'codex', '--model', 'gpt-6.1-sol',
          '--effort', 'high', '--detach']
FIELDS = ('taskId', 'requestId', 'goal', 'deliverables', 'acceptance',
          'ownership', 'authorization', 'deadline')


def _package(data):
    if not isinstance(data, dict) or set(data) != set(FIELDS):
        raise ValidationError('compact package requires exactly: ' + ', '.join(FIELDS))
    result = dict(data)
    ident(result['taskId'], 'taskId')
    if not isinstance(result['requestId'], str) or not REQUEST_RE.fullmatch(result['requestId']):
        raise ValidationError('requestId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}')
    for key in ('goal', 'authorization'):
        text(result[key], key, 4000)
    for key in ('deliverables', 'acceptance', 'ownership'):
        items = result[key]
        if not isinstance(items, list) or not 1 <= len(items) <= 50:
            raise ValidationError(key + ' requires 1..50 strings')
        result[key] = [text(item, key, 500) for item in items]
    value = result['deadline']
    try:
        deadline = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except (ValueError, TypeError, AttributeError):
        raise ValidationError('deadline must be an absolute UTC ISO timestamp') from None
    if deadline.tzinfo is None or deadline.utcoffset().total_seconds() != 0:
        raise ValidationError('deadline must be absolute UTC (Z or +00:00)')
    if len(encoded(result).encode('utf-8')) > 32768:
        raise ValidationError('compact package exceeds 32768 bytes')
    return result


def _public(row):
    return dict(opId=row['op_id'], taskId=row['task_id'], kind=row['kind'], status=row['status'],
                payload=json.loads(row['payload']), createdAt=row['created_at'], updatedAt=row['updated_at'])


def _save(connection, op, now):
    connection.execute('UPDATE operations SET status=?,payload=?,updated_at=? WHERE op_id=?',
                       (op['status'], encoded(op['payload']), now, op['opId']))


def _finish(op, now, code, *, success=False, held=False):
    """Freeze the complete receipt once, before the separate outbox transaction."""
    if op['status'] in TERMINAL:
        return
    p = op['payload']
    op['status'] = 'completed' if success else 'failed'
    p.update(terminalCode=code, capacityHeld=held)
    p['timings']['terminalAt'] = now
    refs = ['operation:' + op['opId'], *p.get('evidenceFiles', [])]
    p['receipt'] = dict(eventId=op['opId'], taskId=op['taskId'], sessionId=p['worker']['sessionId'],
        source=p['worker']['threadId'], turnId='dispatch:' + p['package']['requestId'],
        kind='delivery' if success else 'failed', occurredAt=now,
        summary='External Codex CLI candidate %s (%s); controller review required' %
                ('completed' if success else 'failed', code),
        checklist=[dict(requirement=item, status='unverified', evidence=refs)
                   for item in p['package']['acceptance']],
        limitations=['External CLI candidate; not a native internal Sub Agent.',
                     'Files and runner state are evidence only; no controller acceptance or decision.',
                     'First event may be a session event; model latency is unknown.'])


def _no_launch_budget(op, now):
    code = ('missed-deadline' if parse_iso(now) >= parse_iso(op['payload']['package']['deadline'])
            else 'insufficient-deadline-budget')
    _finish(op, now, code)


class SilentDispatchMixin:
    def dispatch_submit(self, data):
        package = _package(data)
        op_id = KIND + ':' + package['requestId']
        with self._receipt_tx() as connection:
            current = connection.execute('SELECT * FROM operations WHERE op_id=?', (op_id,)).fetchone()
            if current is not None:
                op = _public(current)
                if op['kind'] != KIND or op['payload'].get('package') != package:
                    raise TransitionError('dispatch requestId payload collision')
                return dict(op, reused=True)
            now = self._receipt_now()
            remaining = (parse_iso(package['deadline']) - parse_iso(now)).total_seconds()
            if not 0 < remaining <= 7200:
                raise ValidationError('deadline must be in the next 2 hours')
            outstanding = connection.execute(
                "SELECT payload,status FROM operations WHERE kind=? AND "
                "(status NOT IN ('completed','failed') OR payload LIKE '%\"capacityHeld\":true%')",
                (KIND,)).fetchall()
            if sum(row['status'] not in TERMINAL or json.loads(row['payload']).get('capacityHeld', False)
                   for row in outstanding) >= MAX_OUTSTANDING:
                raise TransitionError('silent dispatch queue is full')
            task = self._require_task(connection, package['taskId'], 'silent-dispatch')
            if task['archive'] == 'archived':
                raise TransitionError('silent dispatch requires an active task')
            if task['thread_id']:
                worker = dict(threadId=task['thread_id'], sessionId=task['thread_id'])
            else:
                sessions = connection.execute(
                    "SELECT * FROM task_sessions WHERE task_id=? AND responsibility_status='active' "
                    "AND archive<>'archived' "
                    'ORDER BY session_id LIMIT 2', (package['taskId'],)).fetchall()
                if len(sessions) != 1:
                    raise TransitionError('silent dispatch requires one active worker thread/session')
                worker = dict(threadId=sessions[0]['thread_id'], sessionId=sessions[0]['session_id'])
            for key, value in worker.items():
                ident(value, key)
                if value == CONTROLLER_THREAD_ID:
                    raise TransitionError('controller cannot be a dispatch worker')
            contract = {key: task[key] for key in ('title', 'goal', 'deliverables', 'acceptance',
                                                  'ownership', 'authorization', 'expected_at')}
            payload = dict(package=package, worker=worker, contract=contract,
                workdir=str(Path(self.state_dir).resolve() / 'silent-dispatch' / package['requestId']),
                launchAttempts=0, capacityHeld=False,
                timings=dict(submittedAt=now, claimedAt=None, launchStartedAt=None,
                    launcherReturnedAt=None, firstEventAt=None, firstEventObservedAt=None,
                    terminalAt=None, enqueuedAt=None, receivedAt=None))
            connection.execute('INSERT INTO operations VALUES (?,?,?,?,?,?,?)',
                (op_id, package['taskId'], KIND, 'queued', encoded(payload), now, now))
            row = connection.execute('SELECT * FROM operations WHERE op_id=?', (op_id,)).fetchone()
            return dict(_public(row), reused=False)

    def dispatch_status(self, op_id):
        with self._receipt_tx(False) as connection:
            row = connection.execute('SELECT * FROM operations WHERE op_id=? AND kind=?',
                                     (op_id, KIND)).fetchone()
            if row is None:
                raise NotFoundError('unknown silent dispatch operation')
            op = _public(row)
            event = connection.execute('SELECT received_at FROM receipts WHERE event_id=?', (op_id,)).fetchone()
            if event:
                op['payload']['timings']['receivedAt'] = event['received_at']
            return op

    def dispatch_list(self, limit=20):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValidationError('dispatch list limit must be 1..100')
        with self._receipt_tx(False) as connection:
            return [_public(row) for row in connection.execute(
                'SELECT * FROM operations WHERE kind=? ORDER BY created_at DESC,rowid DESC LIMIT ?',
                (KIND, limit))]

    def dispatch_claim(self, limit=1):
        if type(limit) is not int or not 1 <= limit <= MAX_ACTIVE:
            raise ValidationError('dispatch claim limit must be 1..2')
        with self._receipt_tx() as connection:
            now = self._receipt_now()
            rows = connection.execute(
                "SELECT * FROM operations WHERE kind=? AND "
                "(status NOT IN ('completed','failed') OR payload LIKE '%\"capacityHeld\":true%')",
                (KIND,)).fetchall()
            active = sum(row['status'] in ACTIVE or json.loads(row['payload']).get('capacityHeld', False)
                         for row in rows)
            claims = []
            queued = sorted((row for row in rows if row['status'] == 'queued'),
                            key=lambda row: (row['created_at'], row['op_id']))
            for row in queued:
                op = _public(row)
                if parse_iso(op['payload']['package']['deadline']) <= parse_iso(now):
                    _finish(op, now, 'missed-deadline')
                    _save(connection, op, now)
                    continue
                if active >= MAX_ACTIVE or len(claims) >= limit:
                    continue
                op['status'] = 'launching'
                op['payload']['claimToken'] = uuid.uuid4().hex
                op['payload']['timings']['claimedAt'] = now
                _save(connection, op, now)
                claims.append(op)
                active += 1
            return claims

    def _dispatch_watch(self):
        with self._receipt_tx(False) as connection:
            return [_public(row) for row in connection.execute(
                "SELECT o.* FROM operations o LEFT JOIN receipts r ON r.event_id=o.op_id "
                "WHERE o.kind=? AND (o.status NOT IN ('completed','failed') OR r.event_id IS NULL "
                "OR o.payload LIKE '%\"capacityHeld\":true%' OR o.payload LIKE '%\"receivedAt\":null%') "
                "ORDER BY o.updated_at,o.op_id LIMIT 100", (KIND,))]

    def _dispatch_change(self, op_id, change):
        with self._receipt_tx() as connection:
            row = connection.execute('SELECT * FROM operations WHERE op_id=? AND kind=?',
                                     (op_id, KIND)).fetchone()
            if row is None:
                raise NotFoundError('unknown silent dispatch operation')
            op = _public(row)
            now = self._receipt_now()
            change(op, now)
            _save(connection, op, now)
            return op


def render_brief(p):
    return '\n'.join([
        '# External Codex CLI candidate task',
        'Work only inside this WORKDIR. Preserve all other changes and user data.',
        'Do not install, commit, push, integrate into the parent checkout, or send controller chat messages.',
        'Do not use native-host, gateway, native create/bind or fake native Sub Agent access.',
        'The planner integrates candidate outputs. This runner cannot review/accept its own work.',
        'Write concise Chinese reports; keep code and identifiers in English.',
        'Keep NOTES.md current. Create DONE only after all deliverables and checks pass.',
        'On failure leave an honest handoff. Do not extend the absolute deadline.',
        'Report tables: project column first; group project rows; name project once; hide ACK/internal process rows.',
        '\n## Compact task (authoritative for this increment)', encoded(p['package']),
        '\n## Registered task contract captured at submit', encoded(p['contract']),
        '\n## Registered worker identity', encoded(p['worker']),
        '\nAbsolute UTC deadline: ' + p['package']['deadline'],
        'Candidate output WORKDIR: ' + p['workdir'],
        'Native internal Sub Agent exists exclusively through the real parent tool; never impersonate it.', ''])


def _read_json(path, limit=65536):
    try:
        if not path.is_file():
            return None
        with path.open('rb') as handle:
            raw = handle.read(limit + 1)
        if len(raw) > limit:
            return None
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _alive(pid):
    if type(pid) is not int or not 0 < pid <= 2147483647:
        return None
    try:
        os.kill(pid, 0)  # Read-only existence probe; never signal or kill a runner.
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return None


class DispatchRunner:
    """Non-waiting collector helper. popen injection is for isolated unit tests."""
    def __init__(self, ledger, *, popen=None):
        self.ledger = ledger
        self._popen = popen or subprocess.Popen
        self._children = {}

    def tick(self):
        # A bad job/receipt never prevents independent jobs and receipt drain.
        errors = 0
        for op in self.ledger._dispatch_watch():
            try:
                self._monitor(op)
            except Exception:
                errors += 1
        claims = self.ledger.dispatch_claim(limit=1)
        for op in claims:
            try:
                self._launch(op)
            except Exception:
                # Even errors after Popen may mean a child exists: never replay.
                self.ledger._dispatch_change(op['opId'], lambda current, now:
                    self._uncertain(current, 'launch-exception'))
                errors += 1
        self.ledger.set_meta('silent_dispatch_error', 'dispatch-job-error' if errors else '')
        return dict(claimed=len(claims), errors=errors)

    @staticmethod
    def _uncertain(op, code):
        if op['status'] not in TERMINAL:
            op['status'] = 'reconciliation-needed'
            op['payload']['reconciliationCode'] = code

    def _launch(self, op):
        p = op['payload']
        root = Path(self.ledger.state_dir).resolve()
        parent = root / 'silent-dispatch'
        parent.mkdir(mode=0o700, exist_ok=True)
        work = parent / p['package']['requestId']
        work.mkdir(mode=0o700, exist_ok=False)
        brief = work / 'BRIEF.md'
        atomic_write(str(brief), render_brief(p))
        atomic_write(str(work / 'intent.json'), encoded(dict(opId=op['opId'],
            requestId=p['package']['requestId'], deadline=p['package']['deadline'],
            claimToken=p['claimToken'])))
        argv = [*PINNED, str(brief), str(work), '1']
        def intent(current, now):
            c = current['payload']
            if (current['status'] != 'launching' or c['claimToken'] != p['claimToken']
                    or c['launchAttempts']):
                raise TransitionError('dispatch launch claim is no longer valid')
            remaining = math.floor((parse_iso(c['package']['deadline']) - parse_iso(now)).total_seconds())
            if remaining < 1:
                _no_launch_budget(current, now)
                return
            c.update(launchAttempts=1, argv=argv, maxSeconds=remaining)
            c['timings']['launchStartedAt'] = now
        op = self.ledger._dispatch_change(op['opId'], intent)
        if op['status'] in TERMINAL:
            return
        env = os.environ.copy()
        env['PATH'] = os.pathsep.join(('/opt/homebrew/bin', '/Users/zhuhe/.local/bin',
                                      env.get('PATH', os.defpath)))
        # Recompute after the durable intent commit; floor never extends deadline.
        remaining = math.floor((parse_iso(p['package']['deadline']) -
                               parse_iso(self.ledger._receipt_now())).total_seconds())
        if remaining < 1:
            self.ledger._dispatch_change(op['opId'], lambda current, now:
                                         _no_launch_budget(current, now))
            return
        # Initialize the original launcher's documented schema ONCE in this new
        # workdir. Its ensure() reuses this exact absolute budget unchanged.
        # An env-only relative limit could drift while Python/launcher starts.
        now = self.ledger._receipt_now()
        deadline_epoch = parse_iso(p['package']['deadline']).timestamp()
        start_epoch = parse_iso(now).timestamp()
        atomic_write(str(work / 'DELEGATE_DEADLINE.json'), encoded(dict(
            schema=1, executor='codex', workdir=str(work), limit_source='silent-dispatch-absolute',
            started_at=now, updated_at=now, start_epoch=start_epoch,
            deadline_at=p['package']['deadline'], deadline_epoch=deadline_epoch,
            max_seconds=deadline_epoch - start_epoch)))
        remaining = math.floor((parse_iso(p['package']['deadline']) -
                               parse_iso(self.ledger._receipt_now())).total_seconds())
        if remaining < 1:
            self.ledger._dispatch_change(op['opId'], lambda current, now:
                                         _no_launch_budget(current, now))
            return
        env['DELEGATE_MAX_SECONDS'] = str(min(remaining, op['payload']['maxSeconds']))
        try:
            with (work / 'launcher.log').open('ab') as log:
                os.fchmod(log.fileno(), 0o600)
                child = self._popen(argv, cwd=str(work), env=env, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        except OSError:
            self.ledger._dispatch_change(op['opId'], lambda current, now:
                                         _finish(current, now, 'launcher-not-started'))
            return
        self._children[op['opId']] = child
        self.ledger._dispatch_change(op['opId'], lambda current, now:
                                     current['payload'].update(launcherPid=child.pid))

    def _monitor(self, op):
        p = op['payload']
        if op['status'] == 'queued':
            return
        child = self._children.get(op['opId'])
        returned = child.poll() if child is not None else None
        if child is not None and returned is not None:
            self._children.pop(op['opId'], None)
        work = Path(p['workdir'])
        state = _read_json(work / 'codex-state.json')
        manifest = _read_json(work / 'codex-task.json')
        deadline = _read_json(work / 'DELEGATE_DEADLINE.json')
        runner_alive = _alive((state or {}).get('pid'))
        alive = runner_alive
        launcher_alive = (returned is None if child is not None else _alive(p.get('launcherPid')))
        if launcher_alive is True:
            alive = True
        event = None
        event_path = work / 'codex-events-1.jsonl'
        if event_path.is_file():
            try:
                with event_path.open('rb') as handle:
                    line = handle.readline(16384)
                value = json.loads(line)
                if isinstance(value, dict):
                    event = value
            except (OSError, ValueError):
                pass
        def observed(current, now):
            c = current['payload']
            timings = c['timings']
            c['evidenceFiles'] = [str(work / name) for name in
                ('intent.json', 'BRIEF.md', 'DELEGATE_DEADLINE.json', 'codex-task.json',
                 'codex-state.json', 'codex-events-1.jsonl', 'launcher.log', 'NOTES.md', 'DONE')
                if (work / name).is_file()]
            if returned is not None and timings['launcherReturnedAt'] is None:
                timings['launcherReturnedAt'] = now
                c['launcherExit'] = returned
            if event is not None and timings['firstEventObservedAt'] is None:
                timings['firstEventObservedAt'] = now
                # Original CLI events need not contain a timestamp: unknown stays null.
                stamp = event.get('timestamp')
                if isinstance(stamp, str):
                    try:
                        timings['firstEventAt'] = parse_iso(stamp).isoformat(timespec='microseconds')
                    except ValidationError:
                        pass
                kind = event.get('type')
                c['firstEventType'] = kind[:80] if isinstance(kind, str) else 'unknown'
                c['firstEventEvidence'] = dict(path=str(event_path),
                    timestampSource='event.timestamp' if timings['firstEventAt'] else 'unknown')
            if current['status'] in TERMINAL:
                if c.get('capacityHeld') and alive is False:
                    c['capacityHeld'] = False
                return
            if manifest is not None:
                valid = all(manifest.get(key) == value for key, value in dict(
                    executor='codex', provider='copilot', base_url='http://127.0.0.1:4150/v1',
                    model='gpt-6.1-sol', effort='high', max_rounds=1,
                    workdir=str(work), brief=str(work / 'BRIEF.md')).items())
                c['manifestVerified'] = valid
                if not valid:
                    _finish(current, now, 'manifest-mismatch', held=alive is not False)
                    return
            # Preserve and audit the original runner deadline, never rewrite it.
            runner_deadline = (deadline or {}).get('deadline_at') or (state or {}).get('deadline_at')
            if runner_deadline:
                c['runnerDeadlineAt'] = runner_deadline
                try:
                    exceeds = parse_iso(runner_deadline) > parse_iso(c['package']['deadline'])
                    if deadline is not None:
                        epoch = deadline.get('deadline_epoch')
                        exceeds = exceeds or (type(epoch) not in (int, float)
                            or (type(epoch) is float and not math.isfinite(epoch))
                            or epoch > parse_iso(c['package']['deadline']).timestamp())
                except ValidationError:
                    exceeds = True
                if exceeds:
                    _finish(current, now, 'runner-deadline-exceeded', held=alive is not False)
                    return
            if parse_iso(now) >= parse_iso(c['package']['deadline']):
                _finish(current, now, 'missed-deadline', held=bool(c['launchAttempts']) and alive is not False)
                return
            if state is not None and state.get('running') is False and alive is False:
                exit_code = state.get('exit_code', state.get('exit'))
                # A terminal timeout may lack a round exit, but it is never success.
                if state.get('failed') is True:
                    _finish(current, now, 'runner-failed')
                elif (c.get('manifestVerified') is True and state.get('done') is True
                      and state.get('failed') is False and type(exit_code) is int):
                    _finish(current, now, 'runner-completed' if exit_code == 0 else 'runner-exit-failed',
                            success=exit_code == 0)
                else:
                    self._uncertain(current, 'incomplete-runner-state')
                return
            # Another collector may observe a just-claimed launch preparing its
            # brief. Give that claim its bounded setup window; never launch it.
            started = timings['launchStartedAt'] or timings['claimedAt']
            expired = started and (parse_iso(now) - parse_iso(started)).total_seconds() >= 5
            if expired and launcher_alive is True:
                self._uncertain(current, 'launcher-timeout')
            elif returned is not None and returned != 0:
                self._uncertain(current, 'launcher-nonzero-unconfirmed')
            elif state and state.get('running') is True and c.get('manifestVerified'):
                if runner_alive is True:
                    current['status'] = 'running'
                else:
                    self._uncertain(current, 'runner-process-unconfirmed')
            elif expired:
                self._uncertain(current, 'launcher-timeout')
        op = self.ledger._dispatch_change(op['opId'], observed)
        if op['status'] in TERMINAL:
            self._enqueue(op)

    def _enqueue(self, op):
        # Receipt is already frozen. A crash here can only retry the same payload.
        status = self.ledger.enqueue_receipt(op['payload']['receipt'])
        received = self.ledger.get_receipt(op['opId'])
        def record(current, now):
            t = current['payload']['timings']
            t['enqueuedAt'] = status['createdAt']
            if received:
                t['receivedAt'] = received['receivedAt']
        self.ledger._dispatch_change(op['opId'], record)

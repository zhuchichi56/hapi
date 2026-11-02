"""Synthetic-only integration tests for /snapshot activity composition."""

import contextlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from orchestra import projects
from orchestra import server as server_module


class SyntheticLedger:
    def __init__(self, path, payload):
        self.path = path
        self.payload = payload
        self.connections = []

    def _connect(self):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        self.connections.append(connection)
        return connection

    def snapshot(self):
        return self.payload


class SnapshotActivityIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='.synthetic-activity-integration-', dir=ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o750)
        self.db_path = str(self.root / 'synthetic.sqlite')
        self.db = sqlite3.connect(self.db_path)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, thread_id TEXT,
                                execution TEXT, review TEXT, archive TEXT);
            CREATE TABLE operations (op_id TEXT PRIMARY KEY, task_id TEXT,
                kind TEXT, status TEXT, payload TEXT, created_at TEXT, updated_at TEXT);
        """)
        self.db.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?)",
                        ('task-a', 'Synthetic alpha', 'thread-a', 'running', 'pending', 'none'))
        stamp = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        self.db.execute("INSERT INTO operations VALUES (?,?,?,?,?,?,?)", (
            'review-example', 'task-a', 'review', 'recorded',
            json.dumps({'result': 'accepted'}), stamp, stamp))
        self.db.commit()
        self.payload = {'tasks': [{'id': 'task-a', 'execution': 'running'}],
                        'collector': {'connected': True}}
        self.ledger = SyntheticLedger(self.db_path, self.payload)
        index = self.root / 'index.json'
        index.write_text(json.dumps({
            'version': 1,
            'goalCompletions': [{
                'taskId': 'task-a', 'reviewOpId': 'review-example',
                'goalSatisfied': True, 'evidence': 'Synthetic whole-goal verification'}]}))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(projects.main(['--state', str(self.state), 'import-index', str(index)]), 0)

    def request(self):
        handler = object.__new__(server_module._SnapshotHandler)
        handler.server = SimpleNamespace(ledger=self.ledger, project_state_dir=self.state)
        responses = []
        handler._send_json = lambda status, payload: responses.append((status, payload))
        handler.path = '/snapshot'
        handler.do_GET()
        return responses[-1]

    def test_snapshot_preserves_tasks_and_hides_raw_goal_declarations(self):
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(body['tasks'], self.payload['tasks'])
        self.assertEqual(body['collector'], {'connected': True})
        activity = body['activity']
        self.assertNotIn('error', activity)
        self.assertEqual(activity['coverage']['completion'], 'explicit-attestations-only')
        events = [event for day in activity['days'] for event in day['completions']]
        self.assertEqual(len(events), 1)
        self.assertEqual(set(events[0]), {'taskId', 'title', 'threadId', 'eventId'})
        self.assertEqual(events[0]['taskId'], 'task-a')
        self.assertNotIn('goalCompletions', body['projectCatalog'])
        serialized = json.dumps(body, ensure_ascii=False)
        for marker in ('goalCompletions', 'reviewOpId', 'review-example',
                       'Synthetic whole-goal verification'):
            self.assertNotIn(marker, serialized)

    def test_unaccepted_review_does_not_count_as_whole_goal_completion(self):
        self.db.execute("UPDATE operations SET payload=? WHERE op_id='review-example'",
                        (json.dumps({'result': 'rejected'}),))
        self.db.commit()
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertNotIn('error', body['activity'])
        events = [event for day in body['activity']['days'] for event in day['completions']]
        self.assertEqual(events, [])
        self.assertEqual(body['tasks'], self.payload['tasks'])

    def test_catalog_failure_fails_closed_only_activity_field(self):
        (self.state / projects.CATALOG_FILE).write_bytes(b'{')
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(body['tasks'], self.payload['tasks'])
        self.assertEqual(body['activity'], {'available': False, 'error': 'activity_unavailable'})
        self.assertEqual(body['projectCatalogError'], 'catalog_unavailable_or_invalid')
        self.assertNotIn('goalCompletions', json.dumps(body, ensure_ascii=False))

    def test_ledger_failure_fails_closed_only_activity_field(self):
        class BrokenLedger:
            def snapshot(self):
                return {'tasks': [{'id': 'task-a'}]}

            def _connect(self):
                raise OSError('synthetic private detail')

        self.ledger = BrokenLedger()
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(body['tasks'], [{'id': 'task-a'}])
        self.assertEqual(body['activity'], {'available': False, 'error': 'activity_unavailable'})
        self.assertNotIn('synthetic private detail', json.dumps(body, ensure_ascii=False))


if __name__ == '__main__':
    unittest.main()

"""Synthetic stdlib checks for daily data and the source snapshot handler."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from orchestra import executor_daily as daily
from orchestra import server


class ExecutorDailyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='synthetic-daily-source-')
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)/'daily.json'
        self.data = dict(schemaVersion='1.0', timezone='Asia/Shanghai',
                         generatedAt='2026-11-03T14:58:11Z', coverage={'missing': None},
                         current={'asOf': '2026-11-03T14:58:11Z', 'stuck': None},
                         days=[{'date': '2026-11-03', 'groups': [{'tokens': None}]}])
        self.path.write_text(json.dumps(self.data))

    def test_handler_embeds_exact_daily_and_preserves_existing_payload(self):
        base = dict(version=1, activity={'available': True}, projectCatalog={'missing': None},
                    tasks=[{'id': 'SYNTHETIC', 'artifacts': [], 'investment': {'tokens': None}}])
        class Handler:
            path = '/snapshot'
            server = type('Server', (), {'ledger': type('Ledger', (), {
                'snapshot': lambda _: copy.deepcopy(base)})()})()
            def _send_json(self, status, payload):
                self.status, self.payload = status, payload
        handler = Handler()
        with patch.object(server, 'attach_task_usage', side_effect=lambda p, _: p), \
             patch.object(server, 'attach_executor_daily',
                          side_effect=lambda p: daily.attach_executor_daily(p, self.path)):
            server._SnapshotHandler.do_GET(handler)
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.payload['executorDaily']['data'], self.data)
        self.assertTrue(handler.payload['executorDaily']['available'])
        self.assertEqual({k:v for k,v in handler.payload.items() if k != 'executorDaily'}, base)

    def test_missing_and_nonfinite_data_degrade_only_daily(self):
        base = {'tasks': [{'investment': {'tokens': None}}]}
        for raw in (None, '{bad', json.dumps(self.data).replace('null', 'NaN')):
            if raw is None:
                self.path.unlink(missing_ok=True)
            else:
                self.path.write_text(raw)
            result = daily.attach_executor_daily(base, self.path)
            self.assertEqual(result['executorDaily'], daily.UNAVAILABLE)
            self.assertEqual(result['tasks'], base['tasks'])

    def test_snapshot_limit_degrades_block_without_discarding_existing_data(self):
        base = {'tasks': [], 'padding': 'x' * daily.SNAPSHOT_LIMIT}
        result = daily.attach_executor_daily(base, self.path)
        self.assertEqual(result['executorDaily'], daily.TOO_LARGE)
        self.assertEqual(result['padding'], base['padding'])

    def test_repeated_read_preserves_source_nulls_and_timestamps(self):
        raw = self.path.read_bytes()
        modified = self.path.stat().st_mtime_ns
        first = daily.executor_daily_block(self.path)
        self.assertEqual(first, daily.executor_daily_block(self.path))
        self.assertEqual(first['data'], self.data)
        self.assertIsNone(first['data']['current']['stuck'])
        self.assertEqual(self.path.read_bytes(), raw)
        self.assertEqual(self.path.stat().st_mtime_ns, modified)


if __name__ == '__main__':
    unittest.main(verbosity=2)

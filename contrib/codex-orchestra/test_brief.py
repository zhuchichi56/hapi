import json
import tempfile
import unittest
from orchestra.ledger import Ledger
from orchestra.brief import write_brief
from orchestra.errors import NotFoundError, ValidationError
from test_orchestra import make_task


class BriefTests(unittest.TestCase):
    def test_explicit_brief_keeps_progress_and_contract(self):
        with tempfile.TemporaryDirectory() as state:
            ledger = Ledger(state)
            make_task(ledger)
            before = ledger.get_task('T100')
            value = write_brief(ledger, 'T100', '核对完成；仍需修复手机入口。', '2026-11-02T04:20:00+08:00')
            self.assertEqual(value['source'], 'controller-written')
            self.assertEqual(ledger.get_task('T100')['progress'], before['progress'])
            self.assertEqual(json.loads(ledger.get_meta('task_brief:T100'))['brief'], value['brief'])

    def test_unknown_task_and_invalid_inputs(self):
        with tempfile.TemporaryDirectory() as state:
            ledger = Ledger(state)
            with self.assertRaises(NotFoundError):
                write_brief(ledger, 'T000', '不存在')
            make_task(ledger)
            for brief in ['', 'x' * 501, 'a\nb\nc']:
                with self.assertRaises(ValidationError):
                    write_brief(ledger, 'T100', brief)
            with self.assertRaises(ValidationError):
                write_brief(ledger, 'T100', '有进展', 'invalid')

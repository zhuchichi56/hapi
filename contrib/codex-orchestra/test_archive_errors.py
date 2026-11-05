import json
import tempfile
import unittest
from orchestra.ledger import Ledger
from orchestra.archive_errors import clear_resolved_archive_error
from test_orchestra import make_task, observation
from orchestra.util import now_iso

class ArchiveErrorTests(unittest.TestCase):
    def test_only_confirmed_resolved_archive_error_is_cleared(self):
        with tempfile.TemporaryDirectory() as state:
            ledger=Ledger(state); make_task(ledger)
            ledger.apply_observation('T100', observation(), now_iso())
            ledger.review('T100', 'accepted', 'verified', 'review-1', actor=ledger.controller_thread_id)
            ledger.archive_request('T100', 'archive-1')
            ledger.set_meta('collector_error', 'archive-run T100 failed: TransitionError')
            self.assertFalse(clear_resolved_archive_error(ledger))
            ledger.archive_receipt('T100', 'receipt-1', 'confirmed', 'native fixture confirmed')
            self.assertTrue(clear_resolved_archive_error(ledger))
            self.assertIsNone(ledger.get_meta('collector_error'))
            self.assertEqual(json.loads(ledger.get_meta('last_resolved_archive_error'))['taskId'], 'T100')
            self.assertEqual(ledger.get_task('T100')['archive'], 'archived')
            ledger.set_meta('collector_error', 'poll query failed: RuntimeError')
            self.assertFalse(clear_resolved_archive_error(ledger))
            self.assertEqual(ledger.get_meta('collector_error'), 'poll query failed: RuntimeError')

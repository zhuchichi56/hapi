"""Isolated silent-policy tests; all transports are in-memory fakes."""

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from .constants import CONTROLLER_THREAD_ID
from .ledger import Ledger
from .receipt_delivery import LedgerReceiver, Outcome, _claim, _finish
from .receipt_recovery import ReceiptRecoveryCollector

KEY = 'receipt_native_wake_enabled'
ROOT = Path(__file__).parent


class Probe:
    is_test = True
    controller_id = CONTROLLER_THREAD_ID

    def __init__(self):
        self.sends = []
        self.reads = []

    def send(self, event):
        self.sends.append(event)
        return Outcome('sent', 'fake-marker', 'fake-turn')

    def reconcile(self, event):
        self.reads.append(event)
        return Outcome('sent', 'fake-read-marker', 'fake-turn')


class SilentReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='silent-', dir=ROOT)
        self.addCleanup(self.tmp.cleanup)
        self.now = datetime(2026, 11, 3, tzinfo=timezone.utc)
        self.ledger = Ledger(self.tmp.name, test_mode=True)
        self.ledger._receipt_now = self.iso
        self.ledger.register(dict(id='T022', title='Silent fixture', threadId='silent-worker'))
        self.probe = Probe()

    def iso(self):
        return self.now.isoformat(timespec='microseconds')

    def payload(self, event):
        return dict(eventId=event, taskId='T022', sessionId='silent-worker', turnId='turn-' + event,
                    kind='delivery', occurredAt=self.iso(), checklist=[], limitations=[],
                    summary='Isolated silent receipt', source='silent-worker')

    def reopen(self):
        self.ledger = Ledger(self.tmp.name, test_mode=True)
        self.ledger._receipt_now = self.iso

    def rows(self, *tables):
        with self.ledger._receipt_tx(False) as connection:
            return {table: [tuple(row) for row in connection.execute('SELECT * FROM ' + table + ' ORDER BY 1')]
                    for table in tables}

    def assert_silent(self):
        self.assertEqual((self.probe.sends, self.probe.reads), ([], []))

    def test_missing_and_persisted_off_outbox_durable_receive_reopen_dedup(self):
        for value in (None, '0'):
            with self.subTest(value=value):
                if value is not None:
                    self.ledger.set_meta(KEY, value)
                self.assertEqual(self.ledger.get_meta(KEY), value)
                event = 'missing' if value is None else 'off'
                data = self.payload(event)
                self.ledger.enqueue_receipt(data)
                self.reopen()
                collector = ReceiptRecoveryCollector(self.ledger, recovery_adapter=self.probe,
                                                      bridge_fn=lambda *args: self.fail('unexpected observation'))
                try:
                    result = collector._recover_receipts()
                finally:
                    collector.close()
                self.assertEqual([(r['queue'], r['status']) for r in result], [('receipt', 'sent')])
                self.assertEqual(self.ledger.delivery_status(event, queue='wake')['status'], 'pending')
                before = self.rows('receipts', 'receipt_wakes', 'receipt_attempts', 'decisions')
                self.reopen()
                ack = self.ledger.receive_receipt(data, wake_adapter=self.probe, wake_mode='sync')
                self.assertEqual((ack['ack'], ack['reused'], ack['acceptedReview']),
                                 ('durable-received', True, False))
                self.assertEqual(ack['receivedAt'], self.ledger.get_receipt(event)['receivedAt'])
                self.assertEqual(before, self.rows(*before))
                events = [r['receiptId'] for r in self.ledger.receipt_review_backlog(include_test=True)['receipts']]
                self.assertIn(event, events)
                jobs = self.ledger.verification_snapshot(include_test=True)['jobs']
                self.assertEqual(sum(job['eventId'] == event for job in jobs), 1)
                self.assert_silent()

    def test_off_preserves_all_pending_unknown_expired_sending_and_history(self):
        for event in ('pending', 'unknown', 'sending', 'sent', 'failed'):
            self.ledger.receive_receipt(self.payload(event))
        claim = _claim(self.ledger, 'unknown', 'wake')
        _finish(self.ledger, 'wake', claim, Outcome('unknown', 'fixture-unknown'))
        _claim(self.ledger, 'sending', 'wake')
        for event, outcome in (('sent', Outcome('sent', 'fixture-marker', 'old-turn')),
                               ('failed', Outcome('failed', 'fixture-failed'))):
            _finish(self.ledger, 'wake', _claim(self.ledger, event, 'wake'), outcome)
        self.now += timedelta(seconds=60)
        self.ledger.review_receipt('sent', dict(reviewId='old-review', result='accepted',
                                              evidence=['file:fixture']), actor_id=CONTROLLER_THREAD_ID)
        self.ledger.create_decision(dict(decisionId='old-decision', receiptId='sent', taskId='T022',
            stageId='stage', sessionId='silent-worker', turnId='turn-sent', decisionRequired=True,
            authority='controller', trigger='Fixture decision', options=['accept', 'rework'],
            owner='silent-worker', dueAt=None), actor_id=CONTROLLER_THREAD_ID)
        before = self.rows('receipt_wakes', 'receipt_attempts', 'receipts', 'receipt_reviews',
                           'decisions', 'decision_revisions')
        for value in (None, '0'):
            with self.subTest(value=value):
                if value is not None:
                    self.ledger.set_meta(KEY, value)
                self.reopen()
                with patch('orchestra.receipt_delivery._claim', side_effect=AssertionError('claim while disabled')):
                    for event in ('pending', 'unknown', 'sending', 'sent', 'failed'):
                        self.ledger.dispatch_wake(event, self.probe)
                    self.assertEqual(self.ledger.drain_receipts(wake_adapter=self.probe), [])
                    collector = ReceiptRecoveryCollector(self.ledger, recovery_adapter=self.probe)
                    try:
                        self.assertEqual(collector._recover_receipts(), [])
                    finally:
                        collector.close()
                self.assertEqual(before, self.rows(*before))
        self.assert_silent()

    def test_off_outbox_lost_ack_recovers_by_durable_read_without_replay(self):
        self.ledger.set_meta(KEY, '0')
        data = self.payload('lost-ack')
        self.ledger.enqueue_receipt(data)
        calls = []
        class LostAck(LedgerReceiver):
            def receive_receipt(receiver, payload):
                calls.append(payload['eventId'])
                super().receive_receipt(payload)
                raise TimeoutError('fake lost ACK')
        self.assertEqual(self.ledger.dispatch_receipt('lost-ack', LostAck(self.ledger))['status'], 'unknown')
        before = self.rows('receipts', 'receipt_wakes')
        self.reopen()
        collector = ReceiptRecoveryCollector(self.ledger, recovery_adapter=self.probe)
        try:
            result = collector._recover_receipts()
        finally:
            collector.close()
        self.assertEqual([(r['queue'], r['status'], r['lastCode']) for r in result],
                         [('receipt', 'sent', 'read-reconciled')])
        self.assertEqual(calls, ['lost-ack'])
        self.assertEqual(before, self.rows(*before))
        self.assert_silent()

    def test_same_collector_rechecks_live_policy(self):
        collector = ReceiptRecoveryCollector(self.ledger, recovery_adapter=self.probe)
        try:
            self.ledger.enqueue_receipt(self.payload('first'))
            self.assertEqual([r['queue'] for r in collector._recover_receipts()], ['receipt'])
            self.assert_silent()
            self.ledger.set_meta(KEY, '1')
            self.assertEqual([r['status'] for r in collector._recover_receipts()], ['sent'])
            self.assertEqual(self.probe.sends, ['first'])
            self.ledger.set_meta(KEY, '0')
            self.ledger.enqueue_receipt(self.payload('second'))
            self.assertEqual([r['queue'] for r in collector._recover_receipts()], ['receipt'])
            self.assertEqual((self.probe.sends, self.probe.reads), (['first'], []))
            self.assertEqual(self.ledger.delivery_status('second', queue='wake')['attempts'], 0)
        finally:
            collector.close()

    def test_explicit_and_installed_sync_adapter_cannot_enable(self):
        self.ledger.wake_adapter = self.probe
        for index, kwargs in enumerate((dict(wake_adapter=self.probe),
                                        dict(wake_adapter=self.probe, wake_mode='sync'),
                                        dict(wake_mode='sync'))):
            ack = self.ledger.receive_receipt(self.payload('sync-%s' % index), **kwargs)
            self.assertEqual((ack['ack'], ack['wake']['status'], ack['wake']['attempts']),
                             ('durable-received', 'pending', 0))
        self.assert_silent()

    def test_invalid_values_fail_closed(self):
        self.ledger.receive_receipt(self.payload('invalid'))
        before = self.rows('receipt_wakes', 'receipt_attempts')
        for value in (None, '', '0', 'true', 'True', 'yes', 'on', '01', '1.0', ' 1', '1 ', '1\n', False, [], {}):
            with self.subTest(value=value):
                self.ledger.set_meta(KEY, value)
                self.reopen()
                self.ledger.dispatch_wake('invalid', self.probe)
                self.assertEqual(self.ledger.drain_receipts(wake_adapter=self.probe), [])
                self.assertEqual(before, self.rows(*before))
        self.assert_silent()

    def test_live_and_restart_switch_reads_and_enabled_unknown_is_read_only(self):
        for event in ('pending', 'unknown'):
            self.ledger.receive_receipt(self.payload(event))
        _finish(self.ledger, 'wake', _claim(self.ledger, 'unknown', 'wake'), Outcome('unknown', 'fixture'))
        writer = Ledger(self.tmp.name, test_mode=True)
        self.ledger.dispatch_wake('pending', self.probe)
        self.assert_silent()
        writer.set_meta(KEY, '1')
        self.assertEqual(self.ledger.dispatch_wake('unknown', self.probe)['status'], 'sent')
        self.assertEqual((self.probe.sends, self.probe.reads), ([], ['unknown']))
        writer.set_meta(KEY, '0')
        before = self.rows('receipt_wakes', 'receipt_attempts')
        self.ledger.dispatch_wake('pending', self.probe)
        self.assertEqual(before, self.rows(*before))
        self.reopen()
        self.assertEqual(self.ledger.get_meta(KEY), '0')
        self.ledger.dispatch_wake('pending', self.probe)
        writer.set_meta(KEY, '1')
        self.reopen()
        self.assertEqual(self.ledger.dispatch_wake('pending', self.probe)['status'], 'sent')
        self.assertEqual((self.probe.sends, self.probe.reads), (['pending'], ['unknown']))

    def test_dispatch_rechecks_when_disabled_during_drain(self):
        self.ledger.receive_receipt(self.payload('race'))
        self.ledger.set_meta(KEY, '1')
        original = self.ledger.get_meta
        calls = []
        def switch_off(key, default=None):
            calls.append(key)
            if len(calls) == 2:
                self.ledger.set_meta(KEY, '0')
            return original(key, default)
        before = self.rows('receipt_wakes', 'receipt_attempts')
        with patch.object(self.ledger, 'get_meta', side_effect=switch_off):
            result = self.ledger.drain_receipts(wake_adapter=self.probe)
        self.assertEqual(result[0]['status'], 'pending')
        self.assertEqual(before, self.rows(*before))
        self.assert_silent()


if __name__ == '__main__':
    unittest.main()

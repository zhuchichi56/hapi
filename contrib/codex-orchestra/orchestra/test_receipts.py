"""Isolated receipt/decision tests: no production ledger, bridge, or native send."""

import copy
import io
import json
import os
import stat
import socketserver
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from .bridge import UnixHTTPConnection
from .cli import main
from .constants import CONTROLLER_THREAD_ID as CONTROLLER
from .errors import BridgeError, NotFoundError, TransitionError, ValidationError
from .ledger import Ledger
from .receipt_delivery import LedgerReceiver, NativeWakeAdapter, Outcome, _claim, _finish
from .server import _SnapshotHandler, _UnixHTTPServer, start_snapshot_server, stop_snapshot_server

BASE = datetime(2026, 11, 2, 15, 0, tzinfo=timezone.utc)
ROOT = os.path.dirname(os.path.abspath(__file__))


class Crash(BaseException):
    pass


class FakeWake:
    is_test = True
    controller_id = CONTROLLER

    def __init__(self, outcomes=None, reads=None):
        self.outcomes = list(outcomes or [Outcome('sent', 'fake-marker', 'native-turn')])
        self.reads = list(reads or [Outcome('unknown', 'fake-absent')])
        self.sends = []
        self.reconciles = []

    def send(self, event):
        self.sends.append(event)
        result = self.outcomes.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result

    def reconcile(self, event):
        self.reconciles.append(event)
        result = self.reads.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result


class FakeNative(NativeWakeAdapter):
    is_test = True


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='t022-test-', dir=ROOT)
        self.now = BASE
        with patch('orchestra.receipts.now_iso', return_value=self.iso()):
            self.ledger = Ledger(self.tmp.name, test_mode=True)
        self.ledger._receipt_now = self.iso
        # This legacy suite explicitly exercises enabled wake/recovery behavior.
        self.ledger.set_meta('receipt_native_wake_enabled', '1')
        self.ledger.register(dict(id='T022', title='Receipt test', threadId='worker-1'))

    def tearDown(self):
        self.tmp.cleanup()

    def iso(self):
        return self.now.isoformat(timespec='microseconds')

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)

    def payload(self, event='event-1', **updates):
        data = dict(eventId=event, taskId='T022', sessionId='worker-1', turnId='turn-1', kind='delivery',
                    occurredAt=self.iso(), checklist=[dict(requirement='tests pass', status='pass', evidence=['file:test-report'])],
                    limitations=[], summary='Safe test delivery', source='worker-source')
        data.update(updates)
        return data

    def review(self, event='event-1', review_id='review-1'):
        return self.ledger.review_receipt(event, dict(reviewId=review_id, result='accepted',
                                                     evidence=['file:independent-review']), actor_id=CONTROLLER)

    def create(self, decision='decision-1', event='event-1', authority='controller', **updates):
        if self.ledger.get_receipt(event) is None:
            self.ledger.receive_receipt(self.payload(event))
        self.review(event, 'review-' + event)
        receipt = self.ledger.get_receipt(event)
        data = dict(decisionId=decision, receiptId=event, taskId='T022', stageId='stage-1',
                    sessionId=receipt['sessionId'], turnId=receipt['turnId'], decisionRequired=True,
                    authority=authority, trigger='Review delivery', options=['accept', 'rework'],
                    owner='worker-1', dueAt=None)
        data.update(updates)
        return self.ledger.create_decision(data, actor_id=CONTROLLER)

    def update(self, action, decision='decision-1', **fields):
        record = self.ledger.get_decision(decision)
        return self.ledger.update_decision(decision, dict(action=action, expectedRevision=record['revision'], **fields), actor_id=CONTROLLER)

    def choose(self, decision='decision-1', **fields):
        data = dict(choice='accept', reason='Independent evidence supports the choice',
                    nextAction='Execute accepted change', decidedBy=CONTROLLER)
        data.update(fields)
        return self.update('choose', decision, **data)

    def count(self, table):
        with self.ledger._receipt_tx(False) as connection:
            return connection.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]

    def test_receive_duplicate_ack_does_not_review_or_create_decision(self):
        wake = FakeWake()
        receipt = self.payload()
        ack = self.ledger.receive_receipt(receipt, wake_adapter=wake)
        again = self.ledger.receive_receipt(copy.deepcopy(receipt), wake_adapter=wake)
        self.assertEqual(ack['ack'], 'durable-received')
        self.assertFalse(ack['acceptedReview'])
        self.assertFalse(ack['reused'])
        self.assertTrue(again['reused'])
        self.assertEqual(again['receivedAt'], ack['receivedAt'])
        self.assertEqual(len(wake.sends), 1)
        self.assertEqual(self.count('receipts'), 1)
        self.assertEqual(self.count('receipt_wakes'), 1)
        self.assertEqual(self.count('decisions'), 0)
        self.assertEqual(len(self.ledger.consume_notices()), 1)
        notice = self.ledger.consume_notices()[0]
        self.ledger.ack_notice(notice['id'])
        self.assertEqual(self.ledger.get_receipt('event-1')['reviews'], [])
        self.assertEqual(self.ledger.get_task('T022')['review'], 'pending')
        self.assertFalse(self.ledger.receive_receipt(receipt)['acceptedReview'])
        self.assertEqual(len(self.ledger.consume_notices()), 0)

    def test_collision_rejects_without_extra_side_effects(self):
        original = self.payload()
        self.ledger.receive_receipt(original)
        for changed in (dict(original, summary='Changed'), dict(original, summary=original['summary'] + ' ')):
            with self.assertRaises(TransitionError):
                self.ledger.receive_receipt(changed, wake_adapter=FakeWake())
        self.assertEqual(self.count('receipts'), 1)
        self.assertEqual(self.count('receipt_wakes'), 1)
        self.assertEqual(len(self.ledger.consume_notices()), 1)

    def test_canonical_json_and_utc_normalization(self):
        data = self.payload(occurredAt='2026-11-02T23:00:00+08:00')
        self.ledger.receive_receipt(data)
        data['occurredAt'] = '2026-11-02T15:00:00Z'
        self.assertTrue(self.ledger.receive_receipt(data)['reused'])
        self.assertEqual(self.ledger.get_receipt('event-1')['occurredAt'], self.iso())

    def test_validation_kinds_checklists_and_unknown_fields(self):
        variants = [dict(kind='notification'), dict(eventId='../bad id'), dict(checklist='pass'),
                    dict(source=CONTROLLER), dict(sessionId='unregistered'), dict(secret='forbidden'), dict(acceptedReview=True),
                    dict(checklist=[dict(requirement='x', status='pass', evidence=[])]),
                    dict(checklist=[dict(requirement='x', status='maybe', evidence=['x'])])]
        for fields in variants:
            with self.subTest(fields=fields), self.assertRaises((ValidationError, TransitionError)):
                self.ledger.receive_receipt(self.payload(**fields))
        self.assertEqual(self.count('receipts'), 0)

    def test_all_receipt_kinds_reuse_old_inbox_without_changing_review(self):
        for kind in ('delivery', 'blocked', 'failed', 'need-input'):
            self.ledger.receive_receipt(self.payload('event-' + kind, kind=kind))
        self.assertEqual(self.count('receipts'), 4)
        self.assertEqual(len(self.ledger.consume_notices()), 4)
        self.assertEqual(self.ledger.get_task('T022')['review'], 'pending')

    def test_durable_receive_precedes_wake(self):
        ledger = self.ledger
        class CheckingWake(FakeWake):
            def send(self, event):
                reopened = Ledger(ledger.state_dir)
                self_receipt = reopened.get_receipt(event)
                if self_receipt is None or reopened.delivery_status(event, queue='wake')['status'] != 'sending':
                    raise AssertionError('not committed before native I/O')
                return super().send(event)
        wake = CheckingWake()
        self.ledger.receive_receipt(self.payload(), wake_adapter=wake)
        self.assertEqual(len(wake.sends), 1)
        self.assertEqual(self.ledger.delivery_status('event-1', queue='wake')['status'], 'sent')

    def test_wake_exception_does_not_undo_ack(self):
        ack = self.ledger.receive_receipt(self.payload(), wake_adapter=FakeWake([RuntimeError('redacted')]))
        self.assertTrue(ack['ok'])
        self.assertEqual(ack['wake']['status'], 'unknown')
        self.assertEqual(self.ledger.delivery_status('event-1', queue='wake')['status'], 'unknown')
        self.assertEqual(self.count('receipts'), 1)

    def test_controller_only_review_and_review_idempotency(self):
        self.ledger.receive_receipt(self.payload())
        with self.assertRaises(TransitionError):
            self.ledger.review_receipt('event-1', dict(reviewId='r', result='accepted', evidence=['x']), actor_id='worker-1')
        first = self.review()
        self.advance(10)
        self.assertEqual(self.review(), first)
        with self.assertRaises(TransitionError):
            self.ledger.review_receipt('event-1', dict(reviewId='review-1', result='rejected', evidence=['x']), actor_id=CONTROLLER)
        self.assertEqual(self.count('receipt_reviews'), 1)
        self.assertEqual(self.ledger.get_task('T022')['review'], 'pending')

    def test_readonly_and_unknown_task_guards(self):
        with self.assertRaises(NotFoundError):
            self.ledger.receive_receipt(self.payload(taskId='T999'))
        self.ledger.register(dict(id='T023', title='History', external=True, readOnly=True))
        with self.assertRaises(TransitionError):
            self.ledger.receive_receipt(self.payload(taskId='T023'))
        with self.assertRaises(TransitionError):
            self.ledger.enqueue_receipt(self.payload(taskId='T023'))

    def test_collector_and_receipt_delivery_notice_dedup(self):
        self.ledger.apply_observation('T022', dict(threadId='worker-1', turnId='turn-1', turnStatus='completed',
                                                  live=False, assistantText='finished'), self.iso())
        self.ledger.receive_receipt(self.payload())
        self.assertEqual(len(self.ledger.consume_notices()), 1)
        self.assertEqual(self.ledger.get_task('T022')['review'], 'awaiting')

    def test_existing_database_migration_is_additive(self):
        # New Ledger on the same installed factory preserves existing tasks and notices.
        self.ledger.receive_receipt(self.payload())
        reopened = Ledger(self.tmp.name)
        self.assertTrue(reopened.receipt_test_mode)
        self.assertEqual(reopened.get_task('T022')['title'], 'Receipt test')
        self.assertIsNotNone(reopened.get_receipt('event-1'))
        self.assertEqual(reopened.get_meta('receipt_decision_schema'), '1')

    def test_concurrent_duplicate_receive_is_atomic(self):
        data = self.payload()
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.ledger.receive_receipt(data), range(12)))
        self.assertEqual(sum(not r['reused'] for r in results), 1)
        self.assertEqual(self.count('receipts'), 1)
        self.assertEqual(self.count('receipt_wakes'), 1)
        self.assertEqual(len(self.ledger.consume_notices()), 1)

    def test_outbox_durable_and_duplicate_enqueue(self):
        data = self.payload()
        self.ledger.enqueue_receipt(data)
        self.ledger.enqueue_receipt(data)
        reopened = Ledger(self.tmp.name)
        self.assertEqual(reopened.delivery_status('event-1')['status'], 'pending')
        with self.assertRaises(TransitionError):
            self.ledger.enqueue_receipt(dict(data, summary='collision'))
        result = reopened.dispatch_receipt('event-1', LedgerReceiver(reopened))
        self.assertEqual(result['status'], 'sent')
        self.assertEqual(self.count('receipt_outbox'), 1)
        self.assertEqual(self.count('receipts'), 1)

    def test_outbox_known_not_sent_backoff_and_retry_bound(self):
        self.ledger.enqueue_receipt(self.payload())
        class Receiver:
            is_test = True
            calls = 0
            def receive_receipt(self, data):
                self.calls += 1
                raise BridgeError('not connected', delivery='not-sent')
        receiver = Receiver()
        first = self.ledger.dispatch_receipt('event-1', receiver)
        self.assertEqual((first['status'], first['attempts']), ('pending', 1))
        self.ledger.dispatch_receipt('event-1', receiver)
        self.assertEqual(receiver.calls, 1)
        self.advance(2)
        second = self.ledger.dispatch_receipt('event-1', receiver)
        self.assertEqual((second['status'], second['attempts']), ('pending', 2))
        self.advance(4)
        third = self.ledger.dispatch_receipt('event-1', receiver)
        self.assertEqual((third['status'], third['attempts']), ('failed', 3))
        self.advance(100)
        self.ledger.dispatch_receipt('event-1', receiver)
        self.assertEqual(receiver.calls, 3)
        with self.ledger._receipt_tx(False) as connection:
            attempts = connection.execute('SELECT status,code FROM receipt_attempts').fetchall()
            self.assertEqual([(r['status'], r['code']) for r in attempts], [('failed', 'transport-not-sent')] * 3)

    def test_outbox_unknown_appears_in_read_reconciles_no_replay(self):
        self.ledger.enqueue_receipt(self.payload())
        ledger = self.ledger
        class LostAck(LedgerReceiver):
            sends = 0
            reads = 0
            def receive_receipt(self, data):
                self.sends += 1
                ledger.receive_receipt(data)
                raise BridgeError('ACK lost', delivery='unknown')
            def get_receipt(self, event):
                self.reads += 1
                return super().get_receipt(event)
        receiver = LostAck(ledger)
        self.assertEqual(ledger.dispatch_receipt('event-1', receiver)['status'], 'unknown')
        self.assertEqual(ledger.dispatch_receipt('event-1', receiver)['status'], 'sent')
        self.assertEqual((receiver.sends, receiver.reads), (1, 1))
        self.assertEqual(self.count('receipt_attempts'), 1)

    def test_outbox_unknown_absent_and_failed_read_never_replay(self):
        self.ledger.enqueue_receipt(self.payload())
        class Ambiguous:
            is_test = True
            sends = 0
            reads = 0
            def receive_receipt(self, data):
                self.sends += 1
                raise TimeoutError()
            def get_receipt(self, event):
                self.reads += 1
                if self.reads == 1:
                    return None
                raise OSError()
        receiver = Ambiguous()
        for _ in range(3):
            self.assertEqual(self.ledger.dispatch_receipt('event-1', receiver)['status'], 'unknown')
        self.assertEqual((receiver.sends, receiver.reads), (1, 2))

    def test_outbox_unknown_different_read_payload_is_not_success(self):
        self.ledger.enqueue_receipt(self.payload())
        class CollisionRead:
            is_test = True
            def receive_receipt(self, data):
                raise TimeoutError()
            def get_receipt(inner, event):
                return self.payload(summary='wrong')
        receiver = CollisionRead()
        self.ledger.dispatch_receipt('event-1', receiver)
        self.assertEqual(self.ledger.dispatch_receipt('event-1', receiver)['status'], 'unknown')

    def test_crash_after_receipt_send_recovers_unknown_then_read(self):
        self.ledger.enqueue_receipt(self.payload())
        ledger = self.ledger
        class CrashAfterSend(LedgerReceiver):
            sends = 0
            def receive_receipt(self, data):
                self.sends += 1
                super().receive_receipt(data)
                raise Crash()
        receiver = CrashAfterSend(ledger)
        with self.assertRaises(Crash):
            ledger.dispatch_receipt('event-1', receiver)
        reopened = Ledger(self.tmp.name)
        reopened._receipt_now = self.iso
        self.assertEqual(reopened.delivery_status('event-1')['status'], 'sending')
        reopened.dispatch_receipt('event-1', receiver)
        self.assertEqual(receiver.sends, 1)
        self.advance(31)
        self.assertEqual(reopened.dispatch_receipt('event-1', receiver)['status'], 'sent')
        self.assertEqual(receiver.sends, 1)

    def test_crash_before_send_is_unknown_not_blind_replay(self):
        self.ledger.enqueue_receipt(self.payload())
        _claim(self.ledger, 'event-1', 'receipt')
        self.advance(31)
        self.assertEqual(self.ledger.dispatch_receipt('event-1', LedgerReceiver(self.ledger))['status'], 'unknown')
        self.assertIsNone(self.ledger.get_receipt('event-1'))

    def test_wake_known_not_sent_recovery(self):
        self.ledger.receive_receipt(self.payload())
        wake = FakeWake([Outcome('not-sent', 'offline'), Outcome('sent', 'marker', 'native-turn')])
        first = self.ledger.dispatch_wake('event-1', wake)
        self.assertEqual(first['status'], 'pending')
        self.ledger.dispatch_wake('event-1', wake)
        self.assertEqual(len(wake.sends), 1)
        self.advance(2)
        self.assertEqual(self.ledger.dispatch_wake('event-1', wake)['status'], 'sent')
        self.assertEqual(len(wake.sends), 2)

    def test_wake_unknown_holds_until_read_marker(self):
        self.ledger.receive_receipt(self.payload())
        wake = FakeWake([Outcome('unknown', 'native-error')],
                        [Outcome('unknown', 'absent'), RuntimeError('failed read'), Outcome('sent', 'marker', 'turn-native')])
        self.assertEqual(self.ledger.dispatch_wake('event-1', wake)['status'], 'unknown')
        self.assertEqual(self.ledger.dispatch_wake('event-1', wake)['status'], 'unknown')
        self.assertEqual(self.ledger.dispatch_wake('event-1', wake)['status'], 'unknown')
        final = self.ledger.dispatch_wake('event-1', wake)
        self.assertEqual((final['status'], final['nativeTurnId']), ('sent', 'turn-native'))
        self.assertEqual(len(wake.sends), 1)
        self.assertEqual(len(wake.reconciles), 3)

    def test_wake_crash_after_send_reopen_reconciles(self):
        self.ledger.receive_receipt(self.payload())
        wake = FakeWake([Crash()], [Outcome('sent', 'marker', 'native-turn')])
        with self.assertRaises(Crash):
            self.ledger.dispatch_wake('event-1', wake)
        reopened = Ledger(self.tmp.name)
        reopened._receipt_now = self.iso
        self.advance(31)
        self.assertEqual(reopened.dispatch_wake('event-1', wake)['status'], 'sent')
        self.assertEqual(len(wake.sends), 1)
        self.assertEqual(len(wake.reconciles), 1)

    def test_wake_concurrency_claim_prevents_storm(self):
        self.ledger.receive_receipt(self.payload())
        entered, release = threading.Event(), threading.Event()
        class BlockingWake(FakeWake):
            def send(self, event):
                entered.set()
                if not release.wait(5):
                    raise AssertionError('test barrier timed out')
                return super().send(event)
        wake = BlockingWake()
        with ThreadPoolExecutor(max_workers=6) as pool:
            first = pool.submit(self.ledger.dispatch_wake, 'event-1', wake)
            self.assertTrue(entered.wait(5))
            rest = list(pool.map(lambda _: self.ledger.dispatch_wake('event-1', wake), range(5)))
            self.assertTrue(all(r['status'] == 'sending' for r in rest))
            release.set()
            self.assertEqual(first.result()['status'], 'sent')
        self.assertEqual(len(wake.sends), 1)
        self.assertEqual(self.count('receipt_attempts'), 1)

    def test_test_ledger_refuses_live_wake_and_wrong_controller(self):
        self.ledger.receive_receipt(self.payload())
        with self.assertRaises(TransitionError):
            self.ledger.dispatch_wake('event-1', NativeWakeAdapter(post=lambda _: self.fail('live adapter called')))
        wake = FakeWake()
        wake.controller_id = 'not-authorized'
        with self.assertRaises(TransitionError):
            self.ledger.dispatch_wake('event-1', wake)
        self.assertEqual(self.ledger.delivery_status('event-1', queue='wake')['attempts'], 0)
        ack = self.ledger.receive_receipt(self.payload(), wake_adapter=NativeWakeAdapter(
            post=lambda _: self.fail('test ledger must not invoke native transport')))
        self.assertEqual(ack['wakeError'], 'wake-policy-rejected')
        self.assertEqual(ack['ack'], 'durable-received')

    def test_test_receipt_cannot_deliver_into_production(self):
        self.ledger.enqueue_receipt(self.payload())
        class ProductionReceiver:
            is_test = False
            def receive_receipt(self, data):
                raise AssertionError('scope guard failed')
        with self.assertRaises(TransitionError):
            self.ledger.dispatch_receipt('event-1', ProductionReceiver())
        self.assertEqual(self.ledger.delivery_status('event-1')['attempts'], 0)

    def test_drain_is_bounded_and_no_extra_decision(self):
        for i in range(3):
            self.ledger.enqueue_receipt(self.payload('event-%d' % i, turnId='turn-%d' % i))
        result = self.ledger.drain_receipts(receiver=LedgerReceiver(self.ledger), limit=2)
        self.assertEqual(len(result), 2)
        self.assertEqual(self.count('receipts'), 2)
        self.assertEqual(self.count('decisions'), 0)
        with self.assertRaises(ValidationError):
            self.ledger.drain_receipts(limit=101)

    def test_decision_requires_review_and_exact_linkage(self):
        self.ledger.receive_receipt(self.payload())
        data = dict(decisionId='d', receiptId='event-1', taskId='T022', stageId='stage', sessionId='worker-1',
                    turnId='turn-1', decisionRequired=True, authority='controller', trigger='need decision',
                    options=['a', 'b'], owner='worker-1', dueAt=None)
        with self.assertRaises(TransitionError):
            self.ledger.create_decision(data, actor_id=CONTROLLER)
        self.review()
        with self.assertRaises(TransitionError):
            self.ledger.create_decision(dict(data, turnId='wrong-turn'), actor_id=CONTROLLER)
        self.assertEqual(self.count('decisions'), 0)
        with self.assertRaises(ValidationError):
            self.ledger.create_decision(dict(data, decisionRequired=False), actor_id=CONTROLLER)

    def test_decision_duplicate_revisions_no_recount_and_history(self):
        self.create()
        self.advance(10)
        self.choose()
        record = self.update('revise', nextAction='Revised action')
        self.assertEqual(record['revision'], 3)
        self.assertEqual(self.count('decisions'), 1)
        self.assertEqual(self.count('decision_revisions'), 3)
        snapshot = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual(snapshot['counts']['decided'], 1)
        self.assertEqual(snapshot['latency'], dict(unit='seconds', basis='receipt-to-first-decision', method='nearest-rank', sampleCount=1, missing=0, p50=10.0, p95=10.0))
        self.assertEqual(len(self.ledger.get_decision('decision-1', history=True)['history']), 3)
        self.assertEqual(self.create()['revision'], 3)
        self.assertEqual(self.count('decisions'), 1)
        with self.assertRaises(TransitionError):
            self.create(trigger='collision')

    def test_invalid_transitions_and_revision_conflict(self):
        self.create()
        for action in ('action', 'verify', 'rework'):
            with self.subTest(action=action), self.assertRaises(TransitionError):
                self.update(action, **({'reason': 'x', 'evidence': ['x']} if action == 'rework' else {}))
        with self.assertRaises(ValidationError):
            self.choose(choice='unrecorded')
        self.choose()
        with self.assertRaises(TransitionError):
            self.choose()
        with self.assertRaises(TransitionError):
            self.ledger.update_decision('decision-1', dict(action='action', expectedRevision=1), actor_id=CONTROLLER)
        with self.assertRaises(TransitionError):
            self.ledger.update_decision('decision-1', dict(action='action', expectedRevision=2), actor_id='worker-1')
        self.assertEqual(self.count('decision_revisions'), 2)

    def test_verification_requires_execution_and_independent_evidence(self):
        self.create()
        self.choose()
        self.update('action')
        with self.assertRaises(TransitionError):
            self.update('revise', nextAction='Cannot change execution after it begins')
        with self.assertRaises(TransitionError):
            self.update('execution-confirm', executionReceiptId='missing', evidence=['file:verify'])
        with self.assertRaises(TransitionError):
            self.update('execution-confirm', executionReceiptId='event-1', evidence=['file:verify'])
        self.advance(5)
        self.ledger.receive_receipt(self.payload('execution', turnId='turn-execute'))
        with self.assertRaises(ValidationError):
            self.update('execution-confirm', executionReceiptId='execution', evidence=[])
        self.update('execution-confirm', executionReceiptId='execution', evidence=['file:execution-confirmation'])
        result = self.update('verify', evidence=['file:independent-verification'])
        self.assertEqual((result['state'], result['verifierId']), ('verified', CONTROLLER))
        self.assertEqual(result['executionReceiptId'], 'execution')
        with self.assertRaises(TransitionError):
            self.update('revise', nextAction='silent rewrite')

    def test_owner_controller_cannot_self_verify(self):
        self.create(owner=CONTROLLER)
        self.choose()
        self.update('action')
        self.advance(5)
        self.ledger.receive_receipt(self.payload('execution', turnId='turn-execute'))
        self.update('execution-confirm', executionReceiptId='execution', evidence=['file:execution-confirmation'])
        with self.assertRaises(TransitionError):
            self.update('verify', evidence=['file:verify'])

    def test_failed_or_old_execution_evidence_cannot_verify(self):
        self.create()
        self.advance(1)
        self.ledger.receive_receipt(self.payload('old-execution', turnId='old-turn'))
        self.advance(1)
        self.choose()
        self.update('action')
        with self.assertRaises(TransitionError):
            self.update('execution-confirm', executionReceiptId='old-execution', evidence=['file:verify'])
        self.advance(1)
        self.ledger.receive_receipt(self.payload('bad-execution', turnId='bad-turn',
                checklist=[dict(requirement='x', status='unverified', evidence=[])]))
        self.update('execution-confirm', executionReceiptId='bad-execution', evidence=['file:execution-attempt'])
        self.assertEqual(self.ledger.decisions_snapshot(include_test=True)['counts']['awaitingVerification'], 1)
        with self.assertRaises(TransitionError):
            self.update('verify', evidence=['file:verification'])

    def test_waiting_user_external_require_authority_evidence(self):
        self.create(authority='user')
        self.create('external-decision', authority='external')
        snapshot = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual((snapshot['counts']['waitingUser'], snapshot['counts']['waitingExternal']), (1, 1))
        self.assertEqual(len(self.ledger.decisions_snapshot(include_test=True, waiting='waiting-user')['decisions']), 1)
        with self.assertRaises(TransitionError):
            self.choose()
        with self.assertRaises(ValidationError):
            self.choose(decidedBy='human-user', authorityEvidence=[])
        self.choose(decidedBy='human-user', authorityEvidence=['file:user-approval'])
        self.assertEqual(self.ledger.decisions_snapshot(include_test=True)['counts']['waitingUser'], 0)

    def test_rework_revoked_history_and_stable_first_latency(self):
        self.create()
        self.advance(10)
        self.choose()
        self.update('action')
        self.advance(10)
        self.update('rework', reason='Execution needs correction', evidence=['file:failure'])
        self.advance(15)
        self.update('revise', trigger='Clarified rework')
        snapshot = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual(snapshot['counts']['longestWait'], 15.0)
        self.assertEqual(snapshot['counts']['allUnresolvedWait'], 35.0)
        self.assertEqual(snapshot['counts']['rework'], 1)
        self.choose()
        self.update('revoke', reason='Cancelled independently', evidence=['file:cancel'])
        snapshot = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual((snapshot['counts']['decided'], snapshot['counts']['pending'], snapshot['counts']['revoked']), (1, 0, 1))
        self.assertEqual(snapshot['latency']['p50'], 10.0)
        with self.assertRaises(TransitionError):
            self.update('revise', trigger='cannot un-revoke')
        history = self.ledger.get_decision('decision-1', history=True)['history']
        self.assertEqual(len(history), 7)
        self.assertEqual(history[1]['controllerChoice'], 'accept')

    def test_test_exclusion_persistent_flag_and_no_empty_percentile(self):
        empty = self.ledger.decisions_snapshot()
        self.assertEqual(empty['latency']['sampleCount'], 0)
        self.assertIsNone(empty['latency']['p50'])
        self.assertIsNone(empty['coverage']['start'])
        self.create()
        self.choose()
        self.assertEqual(self.ledger.decisions_snapshot()['counts']['decided'], 0)
        reopened = Ledger(self.tmp.name)
        self.assertTrue(reopened.receipt_test_mode)
        self.assertEqual(reopened.decisions_snapshot()['decisions'], [])
        self.assertEqual(reopened.decisions_snapshot(include_test=True)['counts']['decided'], 1)
        with tempfile.TemporaryDirectory(dir=ROOT) as production:
            Ledger(production)
            with self.assertRaises(TransitionError):
                Ledger(production, test_mode=True)

    def test_percentiles_use_actual_first_choice_samples(self):
        # Nearest rank over exactly 20 first-choice samples: P50=10, P95=19.
        for i in range(1, 21):
            self.create('d-%02d' % i, 'e-%02d' % i)
            self.advance(i)
            self.choose('d-%02d' % i)
        self.update('revise', 'd-01', nextAction='Revision must not add latency sample')
        stats = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual(stats['latency']['sampleCount'], 20)
        self.assertEqual((stats['latency']['p50'], stats['latency']['p95']), (10.0, 19.0))
        self.assertEqual(stats['counts']['decided'], 20)

    def test_overdue_action_pending_and_longest_wait_measured(self):
        due = (self.now + timedelta(seconds=5)).isoformat()
        self.create(dueAt=due)
        self.create('d2', authority='external')
        self.advance(12)
        stats = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual(stats['counts']['knownOverdue'], 1)
        self.assertEqual(stats['counts']['longestWait'], 12.0)
        self.choose()
        self.update('action')
        stats = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual(stats['counts']['actionPending'], 1)
        self.assertEqual(stats['counts']['knownOverdue'], 1)

    def test_cli_guards_and_roundtrip(self):
        path = os.path.join(self.tmp.name, 'receipt.json')
        with open(path, 'w') as handle:
            json.dump(self.payload(), handle)
        def cli(*args):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = main(['--state', self.tmp.name] + list(args))
            return code, out.getvalue(), err.getvalue()
        self.assertEqual(cli('receipt-enqueue', '--json', path)[0], 0)
        self.assertEqual(cli('receipt-deliver', 'event-1')[0], 0)
        self.assertEqual(json.loads(cli('receipt-status', 'event-1')[1])['status'], 'sent')
        review_file = os.path.join(self.tmp.name, 'review.json')
        with open(review_file, 'w') as handle:
            json.dump(dict(reviewId='r', result='accepted', evidence=['file:review']), handle)
        self.assertEqual(cli('receipt-review', 'event-1', '--json', review_file, '--actor', 'worker-1')[0], 2)
        self.assertEqual(cli('receipt-review', 'event-1', '--json', review_file, '--actor', CONTROLLER)[0], 0)
        self.assertEqual(json.loads(cli('decisions')[1])['interfaceVersion'], 1)

    def test_private_api_read_only_query_guards_and_test_exclusion(self):
        self.create()
        socket_path = os.path.join(self.tmp.name, 'snapshot.sock')
        # This managed executor denies Unix bind. Exercise the real HTTP
        # handler over an in-memory stream; verify server chmod separately.
        self.assertTrue(issubclass(_UnixHTTPServer, socketserver.UnixStreamServer))
        class NoBindServer:
            def __init__(self, path, handler):
                self.server_address = path
                with open(path, 'w'):
                    pass
            def serve_forever(self, **kwargs):
                pass
            def shutdown(self):
                pass
            def server_close(self):
                pass
        with patch('orchestra.server._UnixHTTPServer', NoBindServer):
            server = start_snapshot_server(self.tmp.name, socket_path)
        class MemorySocket:
            def __init__(self, request):
                self.input = io.BytesIO(request)
                self.output = bytearray()
            def makefile(self, mode, buffering=-1):
                return self.input
            def sendall(self, data):
                self.output.extend(data)
        def request(method, path):
            stream = MemorySocket(('%s %s HTTP/1.0\r\nHost: localhost\r\n\r\n' % (method, path)).encode())
            _SnapshotHandler(stream, ('local', 0), server)
            head, body = bytes(stream.output).split(b'\r\n\r\n', 1)
            return int(head.split()[1]), json.loads(body) if body else None
        try:
            self.assertEqual(stat.S_IMODE(os.stat(socket_path).st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(self.tmp.name).st_mode), 0o700)
            code, data = request('GET', '/decisions')
            self.assertEqual(code, 200)
            self.assertEqual(data['decisions'], [])
            self.assertFalse(data['coverage']['includesTest'])
            self.assertEqual(request('HEAD', '/decisions'), (200, None))
            for path in ('/decisions?includeTest=true', '/decisions?state=bad', '/decisions?task=T022&task=T023',
                         '/decisions?waiting=bad', '/decisions?task='):
                self.assertEqual(request('GET', path)[0], 400)
            self.assertEqual(request('GET', '/decisions?waiting=waiting-user')[0], 200)
            self.assertTrue(server.decisions_private)
            server.decisions_private = False
            self.assertEqual(request('GET', '/decisions')[0], 403)
            server.decisions_private = True
            for method in ('POST', 'PATCH', 'PUT', 'DELETE'):
                self.assertEqual(request(method, '/decisions')[0], 405)
        finally:
            stop_snapshot_server(server)

    def test_receipt_occurrence_and_receive_time_are_distinct(self):
        data = self.payload()
        self.advance(123)
        ack = self.ledger.receive_receipt(data)
        saved = self.ledger.get_receipt('event-1')
        self.assertEqual(saved['occurredAt'], BASE.isoformat(timespec='microseconds'))
        self.assertEqual(ack['receivedAt'], self.iso())
        self.assertNotEqual(saved['occurredAt'], saved['receivedAt'])

    def test_bad_ack_and_echo_only_read_remain_unknown(self):
        self.ledger.enqueue_receipt(self.payload())
        ledger = self.ledger
        class BadAck(LedgerReceiver):
            sends = 0
            def receive_receipt(self, data):
                self.sends += 1
                super().receive_receipt(data)
                return dict(ok=True, ack='durable-received', eventId=data['eventId'],
                            receiptId=data['eventId'], receivedAt='invalid-timestamp')
            def get_receipt(inner, event):
                return self.payload()
        receiver = BadAck(ledger)
        self.assertEqual(ledger.dispatch_receipt('event-1', receiver)['status'], 'unknown')
        self.assertEqual(ledger.dispatch_receipt('event-1', receiver)['status'], 'unknown')
        self.assertEqual(receiver.sends, 1)

    def test_receiver_explicit_collision_rejection_is_terminal(self):
        self.ledger.receive_receipt(self.payload(summary='Already received other payload'))
        self.ledger.enqueue_receipt(self.payload())
        result = self.ledger.dispatch_receipt('event-1', LedgerReceiver(self.ledger))
        self.assertEqual((result['status'], result['lastCode']), ('failed', 'receiver-rejected'))
        self.assertEqual(self.count('receipts'), 1)

    def test_late_not_sent_result_cannot_overwrite_unknown_reconciliation(self):
        self.ledger.receive_receipt(self.payload())
        first = _claim(self.ledger, 'event-1', 'wake')
        self.advance(31)
        second = _claim(self.ledger, 'event-1', 'wake')
        self.assertEqual(second['mode'], 'reconcile')
        _finish(self.ledger, 'wake', second, Outcome('sent', 'marker', 'native-turn'))
        result = _finish(self.ledger, 'wake', first, Outcome('not-sent', 'late-connect-error'))
        self.assertEqual((result['status'], result['attempts']), ('sent', 1))
        self.assertEqual(result['nativeTurnId'], 'native-turn')

    def test_recovery_drain_does_not_starve_newer_due_events(self):
        self.ledger.enqueue_receipt(self.payload('old'))
        class Ambiguous:
            is_test = True
            def receive_receipt(self, data):
                raise TimeoutError()
            def get_receipt(self, event):
                return None
        self.ledger.dispatch_receipt('old', Ambiguous())
        self.advance(1)
        self.ledger.enqueue_receipt(self.payload('new', turnId='turn-2'))
        self.advance(1)
        self.ledger.drain_receipts(receiver=Ambiguous(), limit=1)
        self.advance(1)
        result = self.ledger.drain_receipts(receiver=LedgerReceiver(self.ledger), limit=1)
        self.assertEqual(result[0]['eventId'], 'new')
        self.assertEqual(result[0]['status'], 'sent')
        self.assertEqual(self.ledger.delivery_status('old')['status'], 'unknown')

    def test_wake_not_sent_retry_bound_and_missing_proof(self):
        self.ledger.receive_receipt(self.payload())
        wake = FakeWake([Outcome('not-sent', 'offline')] * 3)
        for advance in (0, 2, 4):
            self.advance(advance)
            result = self.ledger.dispatch_wake('event-1', wake)
        self.assertEqual((result['status'], result['attempts']), ('failed', 3))
        self.ledger.receive_receipt(self.payload('event-2', turnId='turn-2'))
        missing_proof = FakeWake([Outcome('sent', 'claimed-success')])
        result = self.ledger.dispatch_wake('event-2', missing_proof)
        self.assertEqual((result['status'], result['lastCode']), ('unknown', 'missing-native-evidence'))

    def test_source_worker_cannot_supply_external_authority_choice(self):
        self.create(authority='external')
        with self.assertRaises(TransitionError):
            self.choose(decidedBy='worker-source', authorityEvidence=['file:worker-claim'])
        self.assertEqual(self.ledger.get_decision('decision-1')['state'], 'pending')

    def test_malformed_action_is_validation_error(self):
        self.create()
        with self.assertRaises(ValidationError):
            self.ledger.update_decision('decision-1', dict(action=[], expectedRevision=1), actor_id=CONTROLLER)

    def test_original_schema_fixture_migrates_preserving_old_review_and_notice(self):
        from .db import SCHEMA as INSTALLED_SCHEMA
        with tempfile.TemporaryDirectory(prefix='legacy-', dir=ROOT) as directory:
            connection = sqlite3.connect(os.path.join(directory, 'orchestra.db'))
            connection.executescript(INSTALLED_SCHEMA)
            connection.execute("INSERT INTO tasks(id,title,created_at,updated_at,review,accepted_turn_id) VALUES (?,?,?,?,?,?)",
                               ('T010', 'Legacy preserved', self.iso(), self.iso(), 'accepted', 'old-turn'))
            connection.execute('INSERT INTO notices VALUES (?,?,?,?,?,?,?)',
                               ('old-notice', 'T010', 'delivery', 'Legacy notice', 'old-key', self.iso(), self.iso()))
            # Fixture-only persistent test marker, before loading the new facade.
            connection.execute("INSERT INTO meta VALUES ('receipt_decision_mode','test')")
            connection.commit()
            connection.close()
            migrated = Ledger(directory, test_mode=True)
            self.assertEqual(migrated.get_task('T010')['accepted_turn_id'], 'old-turn')
            self.assertEqual(migrated.get_task('T010')['review'], 'accepted')
            self.assertEqual(migrated.consume_notices(), [])
            self.assertEqual(migrated.decisions_snapshot()['counts']['decided'], 0)
            self.assertIsNone(migrated.decisions_snapshot()['coverage']['start'])
            with migrated._receipt_tx(False) as connection:
                self.assertIsNotNone(connection.execute('SELECT acknowledged_at FROM notices WHERE id=?', ('old-notice',)).fetchone()[0])
                self.assertEqual(connection.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
            with migrated._receipt_tx() as connection:
                self.assertEqual(connection.execute('PRAGMA synchronous').fetchone()[0], 2)

    def test_receipt_to_decision_includes_unreviewed_inbox_wait(self):
        self.ledger.receive_receipt(self.payload())
        self.advance(25)
        backlog = self.ledger.receipt_review_backlog(include_test=True)
        self.assertEqual((backlog['count'], backlog['oldestWaitSeconds']), (1, 25.0))
        self.assertNotIn('summary', backlog['receipts'][0])
        record = self.create()
        self.assertEqual(record['triggeredAt'], BASE.isoformat(timespec='microseconds'))
        self.assertEqual(record['recordedAt'], self.iso())
        self.assertEqual(record['triggerBasis'], 'receipt-received')
        self.advance(5)
        self.choose()
        stats = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual(stats['latency']['p50'], 30.0)
        self.assertEqual(stats['receiptReviewBacklog']['count'], 0)

    def test_cumulative_first_choice_survives_rework_and_revocation(self):
        self.create()
        self.advance(10)
        self.choose()
        first = self.ledger.get_decision('decision-1')['firstDecidedAt']
        self.advance(5)
        self.update('rework', reason='Reopen', evidence=['file:rework'])
        stats = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual((stats['counts']['decided'], stats['counts']['pending'], stats['counts']['currentlyEffective']), (1, 1, 0))
        public = self.ledger.public_decisions_snapshot(include_test=True)['decisions'][0]
        self.assertEqual(public['decidedAt'], first)
        self.assertEqual(public['pendingSince'], self.iso())
        self.assertNotEqual(public['pendingSince'], public['triggeredAt'])
        self.assertIsNone(public['actionConfirmedAt'])
        self.assertIsNone(public['verifiedAt'])
        self.advance(20)
        current = self.choose()
        self.assertEqual(current['firstDecidedAt'], first)
        self.assertNotEqual(current['latestDecidedAt'], first)
        self.update('revoke', reason='Cancel', evidence=['file:cancel'])
        stats = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual((stats['counts']['decided'], stats['counts']['revoked']), (1, 1))
        self.assertEqual(stats['latency']['sampleCount'], 1)
        self.assertEqual(stats['latency']['p50'], 10.0)

    def test_rework_wait_uses_current_cycle_without_changing_original_latency(self):
        self.create()  # t0: original receipt and trigger.
        self.advance(10)
        self.choose()  # t10: immutable first decision.
        self.advance(90)
        self.update('rework', reason='Reopen at t100', evidence=['file:rework'])
        self.advance(5)  # t105: current pending cycle is five seconds old.
        stats = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual(stats['counts']['pendingDecisionWait'], 5.0)
        self.assertEqual(stats['counts']['longestWait'], 5.0)
        self.assertEqual(stats['counts']['allUnresolvedWait'], 105.0)
        self.assertEqual(stats['latency']['p50'], 10.0)
        self.assertEqual(stats['latency']['p95'], 10.0)
        public = self.ledger.public_decisions_snapshot(include_test=True)['decisions'][0]
        self.assertEqual(public['pendingSince'], (BASE + timedelta(seconds=100)).isoformat(timespec='microseconds'))
        self.assertEqual(public['decidedAt'], (BASE + timedelta(seconds=10)).isoformat(timespec='microseconds'))

    def test_execution_confirmation_and_verification_backlogs_are_separate(self):
        self.create()
        self.choose()
        self.update('action')
        counts = self.ledger.decisions_snapshot(include_test=True)['counts']
        self.assertEqual((counts['awaitingExecution'], counts['awaitingVerification'], counts['pending']), (1, 0, 0))
        with self.assertRaises(TransitionError):
            self.update('verify', evidence=['file:premature-review'])
        self.advance(3)
        self.ledger.receive_receipt(self.payload('execution', turnId='execution-turn'))
        confirmed = self.update('execution-confirm', executionReceiptId='execution', evidence=['file:execution'])
        self.assertEqual(confirmed['state'], 'action-pending')
        self.assertIsNone(confirmed['verifiedAt'])
        counts = self.ledger.decisions_snapshot(include_test=True)['counts']
        self.assertEqual((counts['awaitingExecution'], counts['awaitingVerification'], counts['pending']), (0, 1, 0))
        self.advance(2)
        self.update('verify', evidence=['file:independent-review'])
        counts = self.ledger.decisions_snapshot(include_test=True)['counts']
        self.assertEqual((counts['awaitingExecution'], counts['awaitingVerification']), (0, 0))

    def test_public_projection_exact_shape_and_no_internal_text_fallback(self):
        from .decision_projection import PUBLIC_RECORD_KEYS
        self.create(trigger='INTERNAL-TRIGGER-DO-NOT-PUBLISH')
        public = self.ledger.public_decisions_snapshot(include_test=True)
        self.assertEqual(set(public), {'version','projection','safeDisplay','generatedAt','statisticsStartAt','clock','coverage','decisions'})
        self.assertEqual(set(public['decisions'][0]), set(PUBLIC_RECORD_KEYS))
        self.assertIsNone(public['decisions'][0]['question'])
        self.assertIsNone(public['decisions'][0]['owner'])
        self.assertNotIn('INTERNAL-TRIGGER', json.dumps(public))
        self.update('revise', publicDisplay=dict(question='Safe question', nextAction=None, owner='Safe owner'))
        public = self.ledger.public_decisions_snapshot(include_test=True)
        self.assertEqual(public['decisions'][0]['question'], 'Safe question')
        self.assertTrue(public['decisions'][0]['test'])
        self.assertEqual(self.ledger.snapshot()['systemDecisions']['decisions'], [])
        self.assertIn('receiptReviewBacklog', self.ledger.snapshot())
        with self.assertRaises(ValidationError):
            self.update('revise', publicDisplay=dict(question='x' * 161))
        with self.assertRaises(ValidationError):
            self.update('revise', publicDisplay=dict(evidence='not public'))

    def test_missing_deadlines_are_unknown_and_waits_are_separate(self):
        self.create()
        self.advance(10)
        self.choose()
        self.create('pending-decision', 'pending-receipt')
        self.advance(5)
        stats = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual(stats['counts']['knownOverdue'], 0)
        self.assertEqual(stats['counts']['missingDueAt'], 2)
        self.assertEqual(stats['counts']['overdueUnknown'], 2)
        self.assertIsNone(stats['counts']['overdue'])
        self.assertFalse(stats['coverage']['overdueComplete'])
        self.assertEqual(stats['counts']['pendingDecisionWait'], 5.0)
        self.assertEqual(stats['counts']['allUnresolvedWait'], 15.0)

    def test_existing_collector_recovers_on_its_executor_without_new_timer(self):
        from .receipt_recovery import ReceiptRecoveryCollector
        wake = FakeWake([Outcome('sent', 'marker', 'native-turn')])
        self.ledger.receive_receipt(self.payload())
        collector = ReceiptRecoveryCollector(self.ledger, recovery_adapter=wake, recovery_limit=1, interval=5,
                                              bridge_fn=lambda *args: {})
        # Do not observe any native tasks; invoke existing cadence hooks only.
        try:
            collector._maybe_recover_receipts()
            future = collector._receipt_recovery_future
            result = future.result(timeout=3)
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0]['status'], 'sent')
            collector._maybe_recover_receipts()
            self.assertIsNone(collector._receipt_recovery_future)
            self.assertEqual(len(wake.sends), 1)
            self.assertIn('recovery-polling', self.ledger.get_meta('receipt_recovery_mode'))
        finally:
            collector.close()

    def test_production_receive_defaults_to_durable_ack_without_real_send(self):
        self.ledger.receipt_test_mode = False  # Fixture only; intercept adapter before any transport.
        wake = FakeWake()
        with patch('orchestra.receipt_delivery.NativeWakeAdapter', return_value=wake):
            ack = self.ledger.receive_receipt(self.payload())
        self.assertEqual(ack['wakeMode'], 'durable')
        self.assertNotIn('wake', ack)
        self.assertEqual(wake.sends, [])
        self.assertEqual(self.ledger.delivery_status('event-1', queue='wake')['status'], 'pending')
        explicit = self.ledger.receive_receipt(self.payload(), wake_adapter=wake, wake_mode='sync')
        self.assertEqual(explicit['wake']['status'], 'sent')
        self.assertEqual(wake.sends, ['event-1'])
        self.create()
        host = self.ledger.snapshot()
        self.assertEqual(host['systemDecisions']['projection'], 'T022-public-safe/v1')
        self.assertEqual(host['systemDecisions']['decisions'][0]['decisionId'], 'decision-1')
        self.assertFalse(host['systemDecisions']['decisions'][0]['test'])
        self.assertNotIn('evidence', host['systemDecisions']['decisions'][0])

    def test_missing_trigger_and_negative_clocks_never_invent_latency_or_zero_wait(self):
        self.create()
        self.advance(10)
        self.choose()
        with self.ledger._receipt_tx() as connection:
            row = connection.execute('SELECT payload FROM decisions WHERE decision_id=?', ('decision-1',)).fetchone()
            payload = json.loads(row['payload'])
            payload['triggeredAt'] = None  # Fixture: legacy/unknown source clock.
            connection.execute('UPDATE decisions SET payload=? WHERE decision_id=?', (json.dumps(payload), 'decision-1'))
        stats = self.ledger.decisions_snapshot(include_test=True)
        self.assertEqual(stats['counts']['decided'], 1)
        self.assertEqual(stats['latency']['sampleCount'], 0)
        self.assertEqual(stats['latency']['missing'], 1)
        self.assertIsNone(stats['latency']['p50'])
        self.create('pending-decision', 'pending-receipt')
        self.now = BASE - timedelta(seconds=1)
        stats = self.ledger.decisions_snapshot(include_test=True)
        self.assertIsNone(stats['counts']['pendingDecisionWait'])
        with self.assertRaises(TransitionError):
            self.choose('pending-decision')


class NativeTransportTests(unittest.TestCase):
    def native_read(self, event='event-1', role='user', target=CONTROLLER, turn='native-turn'):
        return dict(ok=True, result=dict(id=target, turns=[dict(id=turn, items=[dict(role=role,
            text=NativeWakeAdapter.marker(event) + ' Durable receipt is ready.')])]))

    def test_send_uses_authorized_action_id_and_read_marker(self):
        commands = []
        def post(command):
            commands.append(command)
            return (200, dict(ok=True)) if command['op'] == 'send' else (200, self.native_read())
        outcome = FakeNative(post=post).send('event-1')
        self.assertEqual(outcome, Outcome('sent', 'native-read-marker', 'native-turn'))
        self.assertEqual([command['op'] for command in commands], ['send', 'read'])
        self.assertRegex(commands[0]['actionId'], r'^orchestra_receipt_[a-f0-9]{32}$')
        self.assertEqual(commands[0]['id'], CONTROLLER)
        self.assertIn('codex-orchestra receipt-get event-1', commands[0]['text'])
        self.assertIn('Task review pending', commands[0]['text'])
        self.assertEqual(set(commands[0]), {'app', 'op', 'id', 'text', 'actionId'})

    def test_http_200_alone_and_native_errors_are_unknown(self):
        for code, payload in ((200, dict(ok=True)), (200, dict(ok=False)), (502, dict(ok=False, delivery='unknown'))):
            with self.subTest(code=code, payload=payload):
                outcome = FakeNative(post=lambda command: (code, payload)).send('event-1')
                self.assertEqual(outcome.status, 'unknown')

    def test_absent_failed_assistant_or_wrong_thread_read_is_unknown(self):
        cases = [(200, self.native_read('other-event')), (200, self.native_read(role='assistant')),
                 (200, self.native_read(target='other-thread')), (500, dict(ok=False)),
                 (200, dict(ok=True, result=dict(id=CONTROLLER, turns=[])))]
        for result in cases:
            with self.subTest(result=result):
                self.assertEqual(FakeNative(post=lambda _: result).reconcile('event-1').status, 'unknown')

    def test_only_explicit_not_sent_classification_can_retry(self):
        self.assertEqual(FakeNative(post=lambda _: (502, dict(ok=False, delivery='not-sent'))).send('event-1').status, 'not-sent')
        self.assertEqual(FakeNative(post=lambda _: (502, dict(ok=False, error='connection refused'))).send('event-1').status, 'unknown')

    def test_read_transport_failure_stays_unknown(self):
        def post(_):
            raise TimeoutError()
        self.assertEqual(FakeNative(post=post).reconcile('event-1').status, 'unknown')


if __name__ == '__main__':
    unittest.main()

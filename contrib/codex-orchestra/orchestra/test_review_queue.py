"""Isolated scheduler/recovery/authority tests, never a native collaboration call."""

import copy
import io
import json
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import threading
import subprocess
import sys
import unittest
from unittest.mock import patch

from .cli import main
from .constants import CONTROLLER_THREAD_ID as PARENT
from .errors import TransitionError, ValidationError
from .ledger import Ledger
from .receipt_delivery import LedgerReceiver, Outcome
from .test_receipts import FakeWake

ROOT = Path(__file__).parent


class ReviewQueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='queue-test-', dir=ROOT)
        self.now = datetime(2026, 11, 2, 17, tzinfo=timezone.utc)
        self.ledger = Ledger(self.tmp.name, test_mode=True)
        self.ledger._receipt_now = self.iso
        self.ledger.register(dict(id='T022', title='Isolated queue test', threadId='queue-worker',
                                  goal='Verify candidate evidence', acceptance=['Parent review required'],
                                  ownership=['Only candidate artifacts'], authorization='Read evidence only'))

    def tearDown(self):
        self.tmp.cleanup()

    def iso(self):
        return self.now.isoformat(timespec='microseconds')

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)

    def receive(self, event='event-0'):
        data = dict(eventId=event, taskId='T022', sessionId='queue-worker', turnId='turn-' + event,
                    kind='delivery', occurredAt=self.iso(), checklist=[dict(requirement='Check exact file',
                    status='unverified', evidence=['file:exact-evidence'])], limitations=['Unverified source'],
                    summary='Candidate receipt', source='queue-worker')
        return self.ledger.receive_receipt(data, wake_mode='durable')

    def call(self, action, data):
        return self.ledger.verification(action, data, actor_id=PARENT)

    def claim(self, **kwargs):
        return self.call('claim', dict(owner='parent-scheduler', **kwargs))

    def mutate(self, action, claim, **kwargs):
        return self.call(action, dict(eventId=claim['eventId'], token=claim['token'],
                                     revision=claim['revision'], **kwargs))

    def snapshot(self):
        return self.ledger.verification_snapshot(include_test=True)

    def get(self, event):
        return self.ledger.verification_package(event)['job']

    def start(self, claim, bound=True, **kwargs):
        data = dict(dispatchId='dispatch-' + claim['token'], **kwargs)
        if bound:
            data['executionId'] = 'native-operator-claim-' + claim['token']
        return self.mutate('start', claim, **data)

    def submit(self, claim, **kwargs):
        return self.mutate('submit', claim, summary='Candidate findings only',
                           evidence=['file:independent-candidate'], limitations=['Operator assertion'], **kwargs)

    def parent_review(self, event, result='accepted'):
        return self.ledger.review_receipt(event, dict(reviewId='parent-review-' + event, result=result,
                                          evidence=['file:parent-independent-review']), actor_id=PARENT)

    def test_execution_id_canonical_direct_start_bind_and_legacy_uuid(self):
        for index, execution_id in enumerate(('/root/t022_native_slow', '/root/t022_native_fast',
                                              '/root/parent/child_1', '01a19ce4-a76d-77d0-8cdd-53ef31f5a442')):
            with self.subTest(execution_id=execution_id):
                self.receive('canonical-%d' % index)
                claim = self.claim()
                if index == 1:
                    claim = self.start(claim, bound=False)
                    dispatch = claim['execution']['dispatch_id']
                else:
                    dispatch = 'dispatch-' + claim['token']
                bound = self.mutate('start', claim, dispatchId=dispatch, executionId=execution_id)
                self.assertEqual(bound['state'], 'running')
                self.assertEqual(bound['execution']['execution_id'], execution_id)
                self.assertEqual(bound['executionProvenance'], 'untrusted-local-operator-claim')
                self.assertFalse(self.submit(bound)['acceptedReview'])

    def test_execution_id_canonical_unknown_reconcile_keeps_exact_tool_identity(self):
        self.call('configure', dict(maxInflight=1)); self.receive()
        intent = self.start(self.claim(), bound=False, leaseSeconds=1)
        self.advance(2)
        self.assertIsNone(self.claim())
        unknown = self.get('event-0')
        self.assertEqual(unknown['state'], 'reconciliation-needed')
        active = self.mutate('reconcile', unknown, outcome='active', executionId='/root/t022_native_slow',
                             evidence=['tool:local-parent-claim-only'])
        self.assertEqual(active['execution']['execution_id'], '/root/t022_native_slow')
        unknown = self.mutate('reconcile', active, outcome='unknown', executionId='/root/t022_native_slow',
                              evidence=['tool:state-unconfirmed'])
        self.assertEqual(self.snapshot()['inflight'], 1)
        # Reconcile must also validate the canonical identity already persisted.
        active = self.mutate('reconcile', unknown, outcome='active', evidence=['tool:parent-claim-only'])
        with self.assertRaises(TransitionError):
            self.mutate('reconcile', active, outcome='active', executionId='/root/t022_native_fast', evidence=['tool:wrong-id'])
        done = self.mutate('reconcile', active, outcome='completed', executionId='/root/t022_native_slow',
                           evidence=['file:candidate'], summary='Candidate only', limitations=['Untrusted local assertion'])
        self.assertEqual(done['execution']['execution_id'], '/root/t022_native_slow')
        self.assertFalse(done['acceptedReview'])

    def test_execution_id_invalid_values_rejected_without_state_mutation(self):
        invalid = (None, 1, '', ' ', '/root/with space', '/root/child\n', '/root/child\t',
                   '/root/child\x00', '/' + 'x'*160, 'x'*161, '//root/child', '/root//child', '/root/../child')
        self.receive()
        reserved = self.claim()
        for value in invalid:
            with self.subTest(phase='direct-start', value=value), self.assertRaises(ValidationError):
                self.mutate('start', reserved, dispatchId='invalid-test', executionId=value)
        self.assertEqual(self.get('event-0'), reserved)
        intent = self.start(reserved, bound=False)
        for value in invalid:
            with self.subTest(phase='bind', value=value), self.assertRaises(ValidationError):
                self.mutate('start', intent, dispatchId=intent['execution']['dispatch_id'], executionId=value)
            with self.subTest(phase='reconcile', value=value), self.assertRaises(ValidationError):
                self.mutate('reconcile', intent, outcome='active', executionId=value, evidence=['tool:invalid'])
        self.assertEqual(self.get('event-0'), intent)

    def test_execution_id_canonical_support_does_not_relax_other_identifiers(self):
        self.receive()
        with self.assertRaises(ValidationError): self.call('claim', dict(owner='/root/worker'))
        claim = self.claim()
        with self.assertRaises(ValidationError):
            self.mutate('start', claim, dispatchId='/root/dispatch', executionId='stable-id')
        with self.assertRaises(ValidationError):
            self.call('renew', dict(eventId=claim['eventId'], token='/root/token', revision=claim['revision']))
        with self.assertRaises(ValidationError):
            self.ledger.verification_package('/root/event')
        self.assertEqual(self.get('event-0'), claim)

    def test_controller_review_retires_all_results_before_dispatch_even_after_duplicate_expiry_reopen(self):
        for result in ('accepted', 'needs-rework', 'rejected'):
            for state in ('queued', 'claimed'):
                with self.subTest(result=result, state=state):
                    event = result + '-' + state
                    self.receive(event)
                    reserved = self.claim(leaseSeconds=1) if state == 'claimed' else None
                    before = self.get(event)
                    review = self.parent_review(event, result)
                    retired = self.get(event)
                    self.assertEqual(retired['state'], 'controller-reviewed')
                    self.assertEqual(retired['revision'], before['revision'] + 1)
                    self.assertIsNone(retired['token'])
                    self.assertIsNone(retired['leaseUntil'])
                    self.assertIsNone(retired['candidate'])
                    self.assertIsNone(retired['candidateFinishedAt'])
                    self.assertEqual(self.parent_review(event, result), review)
                    self.assertEqual(self.get(event)['revision'], retired['revision'])
                    saved = self.ledger.get_receipt(event)
                    payload = {k: v for k, v in saved.items() if k not in ('receiptId','receivedAt','isTest','reviews')}
                    self.assertTrue(self.ledger.receive_receipt(payload)['reused'])
                    self.advance(1000)
                    self.assertIsNone(self.claim())
                    self.ledger = Ledger(self.tmp.name)
                    self.ledger._receipt_now = self.iso
                    self.assertIsNone(self.claim())
                    self.assertEqual(self.ledger.verification_snapshot(include_test=True, ready=True)['jobs'], [])
                    if reserved:
                        with self.assertRaises(TransitionError): self.start(reserved)
                    with self.ledger._receipt_tx(False) as conn:
                        history = conn.execute("SELECT request FROM verification_history WHERE event_id=? AND action='controller-reviewed'", (event,)).fetchall()
                    self.assertEqual(len(history), 1)
                    self.assertEqual(json.loads(history[0]['request'])['result'], result)

    def test_controller_review_and_retirement_audit_commit_or_rollback_together(self):
        from . import review_queue
        self.receive()
        reserved = self.claim()
        real_retire = review_queue.retire_reviewed
        def fail_after_retirement(*args):
            real_retire(*args)
            raise RuntimeError('simulated failure after retirement audit')
        with patch.object(review_queue, 'retire_reviewed', side_effect=fail_after_retirement):
            with self.assertRaises(RuntimeError): self.parent_review('event-0')
        self.assertEqual(self.ledger.get_receipt('event-0')['reviews'], [])
        self.assertEqual(self.get('event-0')['revision'], reserved['revision'])
        self.assertEqual(self.get('event-0')['token'], reserved['token'])
        self.parent_review('event-0')
        self.assertEqual(self.get('event-0')['state'], 'controller-reviewed')

    def test_concurrent_review_and_claim_cannot_dispatch_reviewed_receipt(self):
        self.receive()
        barrier = threading.Barrier(2)
        def review():
            barrier.wait()
            return self.parent_review('event-0')
        def claim():
            barrier.wait()
            return self.claim()
        with ThreadPoolExecutor(max_workers=2) as executor:
            future_review = executor.submit(review)
            future_claim = executor.submit(claim)
            future_review.result(timeout=3)
            reserved = future_claim.result(timeout=3)
        self.assertEqual(self.get('event-0')['state'], 'controller-reviewed')
        self.assertIsNone(self.claim())
        if reserved:
            with self.assertRaises(TransitionError): self.start(reserved)
        with self.ledger._receipt_tx(False) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM verification_runs').fetchone()[0], 0)

    def test_concurrent_review_and_start_preserves_already_dispatched_capacity(self):
        self.receive(); self.call('configure', dict(maxInflight=1))
        reserved = self.claim()
        barrier = threading.Barrier(2)
        def review():
            barrier.wait()
            return self.parent_review('event-0')
        def start():
            barrier.wait()
            try: return self.start(reserved, bound=False)
            except TransitionError: return None
        with ThreadPoolExecutor(max_workers=2) as executor:
            future_review = executor.submit(review)
            future_start = executor.submit(start)
            future_review.result(timeout=3)
            dispatched = future_start.result(timeout=3)
        current = self.get('event-0')
        if dispatched:
            self.assertEqual(current['state'], 'dispatching')
            self.assertEqual(self.snapshot()['inflight'], 1)
            closed = self.mutate('reconcile', current, outcome='not-started', evidence=['tool:parent-confirmed-no-call'])
            self.assertEqual(closed['state'], 'controller-reviewed')
        else:
            self.assertEqual(current['state'], 'controller-reviewed')
            self.assertEqual(self.snapshot()['inflight'], 0)
        self.assertIsNone(self.claim())

    def test_controller_review_does_not_release_dispatched_running_or_unknown_execution(self):
        self.call('configure', dict(maxInflight=1))
        for state in ('dispatching', 'running', 'reconciliation-needed'):
            with self.subTest(state=state):
                self.receive(state)
                execution = self.start(self.claim(), bound=state != 'dispatching', leaseSeconds=1)
                if state == 'reconciliation-needed':
                    self.advance(2)
                    self.assertIsNone(self.claim())
                    execution = self.get(state)
                self.parent_review(state)
                current = self.get(state)
                self.assertEqual(current['state'], state)
                self.assertEqual(current['revision'], execution['revision'])
                self.assertEqual(current['token'], execution['token'])
                self.assertEqual(self.snapshot()['inflight'], 1)
                self.assertIsNone(self.claim())
                outcome = 'not-started' if state == 'dispatching' else 'stopped'
                closed = self.mutate('reconcile', current, outcome=outcome, evidence=['tool:parent-confirmed-terminal'])
                self.assertEqual(closed['state'], 'controller-reviewed')
                self.assertIsNone(closed['candidate'])
                self.assertEqual(self.snapshot()['inflight'], 0)
                self.assertIsNone(self.claim())

    def test_legacy_review_insert_is_excluded_from_ready_claim_and_direct_start(self):
        for state in ('queued', 'claimed'):
            self.receive(state)
            reserved = self.claim() if state == 'claimed' else None
            record = dict(reviewId='legacy-' + state, receiptId=state, result='accepted',
                          evidence=['file:existing-parent-review'], reviewerId=PARENT, reviewedAt=self.iso())
            with self.ledger._receipt_tx() as conn:
                conn.execute('INSERT INTO receipt_reviews VALUES (?,?,?,?)',
                             (record['reviewId'], state, json.dumps(record), self.iso()))
            self.assertEqual(self.ledger.verification_snapshot(include_test=True, ready=True)['jobs'], [])
            if reserved:
                with self.assertRaises(TransitionError): self.start(reserved)
            self.assertIsNone(self.claim())
            self.assertEqual(self.get(state)['state'], 'controller-reviewed')

    def test_candidate_v1_check_upgrade_preserves_runs_history_and_foreign_keys(self):
        from .review_schema import JOBS_SQL, migrate
        self.receive('reviewed')
        reviewed = self.claim()
        self.receive('active')
        active = self.start(self.claim())
        self.receive('pending')
        record = dict(reviewId='old-parent-review', receiptId='reviewed', result='accepted',
                      evidence=['file:existing-review'], reviewerId=PARENT, reviewedAt=self.iso())
        with self.ledger._receipt_tx() as conn:
            conn.execute('INSERT INTO receipt_reviews VALUES (?,?,?,?)',
                         (record['reviewId'], 'reviewed', json.dumps(record), self.iso()))
            self.ledger._set_meta(conn, 'verification_schema', '1')
        # Build an actual prior-candidate SQLite CHECK fixture with existing FKs.
        connection = sqlite3.connect(str(Path(self.tmp.name) / 'orchestra.db'))
        connection.row_factory = sqlite3.Row
        try:
            old_sql = JOBS_SQL.replace(",\'controller-reviewed\'", '').replace('verification_jobs (', 'old_jobs (', 1)
            connection.execute(old_sql)
            connection.execute('INSERT INTO old_jobs SELECT * FROM verification_jobs')
            connection.execute('DROP TABLE verification_jobs')
            connection.execute('ALTER TABLE old_jobs RENAME TO verification_jobs')
            connection.commit()
            connection.execute('PRAGMA foreign_keys=ON')
            migrate(connection)
            self.assertEqual(connection.execute('PRAGMA foreign_keys').fetchone()[0], 1)
            self.assertEqual(connection.execute('PRAGMA foreign_key_check').fetchall(), [])
        finally:
            connection.close()
        self.ledger = Ledger(self.tmp.name)
        self.ledger._receipt_now = self.iso
        closed = self.get('reviewed')
        self.assertEqual(closed['state'], 'controller-reviewed')
        self.assertEqual(closed['revision'], reviewed['revision'] + 1)
        self.assertEqual(self.get('active')['execution'], active['execution'])
        self.assertEqual(self.snapshot()['inflight'], 1)
        self.assertEqual(self.claim()['eventId'], 'pending')
        self.assertEqual(self.ledger.get_meta('verification_schema'), '2')

    def test_receive_duplicate_atomic_job_and_payload_collision(self):
        ack = self.receive()
        again = self.receive()
        self.assertFalse(ack['reused'])
        self.assertTrue(again['reused'])
        self.assertEqual(self.snapshot()['states'], dict(queued=1))
        saved = self.ledger.get_receipt('event-0')
        raw = {k: saved[k] for k in ('eventId','taskId','sessionId','turnId','kind','occurredAt','checklist','limitations','summary','source')}
        with self.assertRaises(TransitionError):
            self.ledger.receive_receipt(dict(raw, summary='collision'))
        with self.ledger._receipt_tx(False) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM verification_jobs').fetchone()[0], 1)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM receipt_wakes').fetchone()[0], 1)

    def test_concurrent_claim_collision_global_default3_and_cap4(self):
        for number in range(12):
            self.receive('event-%02d' % number)
        # Separate Ledger instances model separate CLI processes sharing SQLite.
        ledgers = [Ledger(self.tmp.name) for _ in range(12)]
        for ledger in ledgers:
            ledger._receipt_now = self.iso
        barrier = threading.Barrier(12)
        def claim(ledger):
            barrier.wait()
            return ledger.verification('claim', dict(owner='concurrent'), actor_id=PARENT)
        with ThreadPoolExecutor(max_workers=12) as executor:
            claims = [c for c in executor.map(claim, ledgers) if c]
        self.assertEqual(len(claims), 3)
        self.assertEqual(len({c['eventId'] for c in claims}), 3)
        self.assertEqual(len({c['token'] for c in claims}), 3)
        self.assertEqual(self.snapshot()['inflight'], 3)
        self.assertIsNone(self.claim())
        self.call('configure', dict(maxInflight=4))
        self.assertIsNotNone(self.claim())
        self.assertIsNone(self.claim())
        self.assertEqual(self.snapshot()['inflight'], 4)
        with self.assertRaises(ValidationError): self.call('configure', dict(maxInflight=5))
        with self.assertRaises(TransitionError): self.call('configure', dict(maxInflight=3))

    def test_reservation_expiry_requeue_stale_token_cannot_finish_new_claim(self):
        self.receive()
        first = self.claim(leaseSeconds=1)
        self.advance(2)
        self.assertIsNone(self.claim())  # Expiry committed, bounded backoff.
        queued = self.get('event-0')
        self.assertEqual(queued['state'], 'queued')
        self.advance(3)
        second = self.claim()
        self.assertNotEqual(first['token'], second['token'])
        self.assertGreater(second['revision'], first['revision'])
        for action in ('start', 'renew', 'submit'):
            with self.assertRaises((TransitionError, ValidationError)):
                if action == 'start': self.start(first)
                elif action == 'submit': self.submit(first)
                else: self.mutate(action, first)
        running = self.start(second)
        self.assertEqual(self.submit(running)['state'], 'submitted')
        self.assertEqual(self.get('event-0')['firstClaimAt'], first['firstClaimAt'])

    def test_late_actual_execution_result_cannot_complete_replacement_claim(self):
        self.receive()
        old = self.start(self.claim())
        released = self.mutate('reconcile', old, outcome='stopped', evidence=['tool:parent-confirmed-stopped'])
        self.advance(3)
        replacement = self.start(self.claim())
        with self.assertRaises(TransitionError): self.submit(old)
        with self.assertRaises(TransitionError):
            self.mutate('reconcile', old, outcome='completed', evidence=['tool:late-result'],
                        summary='Late old execution', limitations=[])
        self.assertEqual(self.get('event-0')['token'], replacement['token'])
        self.assertEqual(self.submit(replacement)['state'], 'submitted')

    def test_transaction_failure_rolls_back_receipt_notice_wake_and_job(self):
        from . import review_queue
        real_enqueue = review_queue.enqueue
        def fail_after_insert(*args):
            real_enqueue(*args)
            raise RuntimeError('simulated crash before commit')
        with patch.object(review_queue, 'enqueue', side_effect=fail_after_insert):
            with self.assertRaises(RuntimeError): self.receive()
        with self.ledger._receipt_tx(False) as conn:
            for table in ('receipts', 'receipt_wakes', 'verification_jobs', 'notices'):
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0], 0)
        self.assertFalse(self.receive()['reused'])

    def test_actual_process_exit_after_dispatch_intent_reopens_safely(self):
        self.receive()
        script = '''
import os, sys
from orchestra.ledger import Ledger
from orchestra.constants import CONTROLLER_THREAD_ID as PARENT
ledger = Ledger(sys.argv[1])
ledger._receipt_now = lambda: '2026-11-02T17:00:00.000000+00:00'
ledger.verification('configure', dict(maxInflight=1), actor_id=PARENT)
claim = ledger.verification('claim', dict(owner='crashing-parent',leaseSeconds=1), actor_id=PARENT)
ledger.verification('start', dict(eventId=claim['eventId'],token=claim['token'],revision=claim['revision'],
    dispatchId='persisted-before-process-exit',leaseSeconds=1), actor_id=PARENT)
os._exit(23)
'''
        result = subprocess.run([sys.executable, '-c', script, self.tmp.name],
                                env=dict(os.environ, PYTHONPATH=str(ROOT.parent)), capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 23, result.stderr.decode())
        self.advance(2)
        self.ledger = Ledger(self.tmp.name)
        self.ledger._receipt_now = self.iso
        self.assertEqual(self.snapshot()['maxInflight'], 1)
        self.assertIsNone(self.claim())
        unknown = self.get('event-0')
        self.assertEqual(unknown['state'], 'reconciliation-needed')
        self.assertEqual(unknown['execution']['dispatch_id'], 'persisted-before-process-exit')
        self.assertEqual(self.snapshot()['inflight'], 1)

    def test_active_execution_lease_expiry_holds_slot_until_parent_reconciles(self):
        self.call('configure', dict(maxInflight=1))
        self.receive('slow'); self.receive('next')
        running = self.start(self.claim(), leaseSeconds=1)
        self.advance(2)
        self.assertIsNone(self.claim())
        unknown = self.get(running['eventId'])
        self.assertEqual(unknown['state'], 'reconciliation-needed')
        self.assertEqual(self.snapshot()['inflight'], 1)
        self.assertEqual(unknown['execution']['state'], 'unknown')
        with self.assertRaises(TransitionError): self.mutate('release', unknown, reason='lease expired')
        with self.assertRaises(TransitionError): self.submit(running)
        still = self.mutate('reconcile', unknown, outcome='unknown', evidence=['tool:state-unavailable'])
        self.assertIsNone(self.claim())
        active = self.mutate('reconcile', still, outcome='active', evidence=['tool:parent-readback'])
        self.assertEqual(active['state'], 'running')
        self.assertEqual(self.submit(active)['state'], 'submitted')
        self.assertIsNotNone(self.claim())

    def test_dispatch_intent_before_tool_crash_reopen_does_not_relaunch(self):
        self.call('configure', dict(maxInflight=1)); self.receive()
        dispatch = self.start(self.claim(), bound=False, leaseSeconds=1)
        self.assertIsNone(dispatch['firstStartAt'])
        self.assertEqual(dispatch['state'], 'dispatching')
        self.advance(2)
        reopened = Ledger(self.tmp.name)
        reopened._receipt_now = self.iso
        self.ledger = reopened
        self.assertTrue(reopened.receipt_test_mode)
        self.assertIsNone(self.claim())
        unknown = self.get('event-0')
        self.assertEqual(unknown['state'], 'reconciliation-needed')
        self.assertIsNone(unknown['execution']['execution_id'])
        stopped = self.mutate('reconcile', unknown, outcome='not-started', evidence=['tool:parent-confirmed-no-invocation'])
        self.assertEqual(stopped['state'], 'queued')
        self.advance(3)
        self.assertIsNotNone(self.claim())

    def test_dispatch_bind_identity_then_exact_replay_and_submit_idempotence(self):
        self.receive()
        reserved = self.claim()
        intent = self.start(reserved, bound=False)
        bound = self.mutate('start', intent, dispatchId=intent['execution']['dispatch_id'], executionId='real-parent-tool-id')
        self.assertEqual(bound['state'], 'running')
        self.assertEqual(bound['execution']['execution_id'], 'real-parent-tool-id')
        done = self.submit(bound)
        self.assertEqual(self.submit(bound), done)
        self.assertEqual(done['execution']['state'], 'completed')
        self.assertTrue(done['candidate']['candidateOnly'])
        self.assertFalse(done['acceptedReview'])
        with self.assertRaises(TransitionError): self.start(reserved)

    def test_reconcile_completed_expired_execution_is_candidate_only(self):
        self.receive()
        run = self.start(self.claim(), leaseSeconds=1)
        self.advance(2)
        # Reconcile can directly resolve current expired run before scheduler recovery.
        done = self.mutate('reconcile', run, outcome='completed', evidence=['tool:parent-result'],
                           summary='Verified candidate evidence', limitations=['Untrusted local claim'])
        self.assertEqual(done['state'], 'submitted')
        self.assertEqual(self.ledger.get_receipt('event-0')['reviews'], [])
        self.assertEqual(self.ledger.get_task('T022')['review'], 'pending')
        self.assertEqual(self.ledger.decisions_snapshot(include_test=True)['decisions'], [])

    def test_unknown_execution_blocks_even_after_very_long_timeout(self):
        self.receive(); self.call('configure', dict(maxInflight=1))
        run = self.start(self.claim())
        self.advance(86400)
        self.assertIsNone(self.claim())
        self.advance(86400)
        self.assertIsNone(self.claim())
        unknown = self.get('event-0')
        with self.assertRaises(TransitionError):
            self.mutate('reconcile', unknown, outcome='not-started', evidence=['tool:invalid-confirmation'])
        queued = self.mutate('reconcile', unknown, outcome='stopped', evidence=['tool:parent-confirmed-terminal'])
        self.assertEqual(queued['state'], 'queued')

    def test_release_backoff_and_retry_exhaustion_bounded3(self):
        self.receive()
        for attempt in range(1, 4):
            claim = self.claim()
            self.assertEqual(claim['attempts'], attempt)
            result = self.mutate('release', claim, reason='No execution launched')
            self.assertEqual(result['state'], 'failed' if attempt == 3 else 'queued')
            self.assertIsNone(self.claim())
            self.advance(10)
        self.assertIsNone(self.claim())
        self.assertEqual(self.snapshot()['states'], dict(failed=1))

    def test_expiry_retry_exhaustion_bounded3(self):
        self.receive()
        for _ in range(3):
            self.assertIsNotNone(self.claim(leaseSeconds=1))
            self.advance(2)
            self.assertIsNone(self.claim())
            self.advance(10)
        self.assertEqual(self.get('event-0')['state'], 'failed')

    def test_renew_preserves_first_claim_and_rejects_late_renew(self):
        self.receive()
        claim = self.claim(leaseSeconds=2)
        self.advance(1)
        renewed = self.mutate('renew', claim, leaseSeconds=10)
        self.assertEqual(renewed['firstClaimAt'], claim['firstClaimAt'])
        self.advance(2)
        self.assertEqual(self.snapshot()['inflight'], 1)
        self.advance(9)
        with self.assertRaises(TransitionError): self.mutate('renew', renewed)

    def test_age_prevents_new_high_priority_starvation_and_oldest_tie(self):
        self.receive('old-low')
        self.advance(601)
        self.receive('new-high')
        high = self.get('new-high')
        self.call('priority', dict(eventId='new-high', revision=high['revision'], priority=10))
        first = self.claim()
        self.assertEqual(first['eventId'], 'old-low')
        self.assertEqual(self.claim()['eventId'], 'new-high')
        self.receive('tie-a'); self.receive('tie-b')
        self.assertEqual(self.claim()['eventId'], 'tie-a')

    def test_ready_summary_priority_and_bounded_packages(self):
        for number in range(5): self.receive('event-%d' % number)
        ready = self.ledger.verification_snapshot(include_test=True, ready=True, limit=2)
        self.assertEqual(len(ready['jobs']), 2)
        self.assertEqual(ready['summary']['kind'], 'coalesced-ready-package-summary')
        self.assertIn('no native batch', ready['summary']['nativeWakeTransport'])
        self.assertEqual(ready['inflight'], 0)
        self.assertEqual(len(ready['packageSummaries']), 2)
        self.assertEqual(ready['packageSummaries'][0]['taskId'], 'T022')
        self.assertEqual(ready['packageSummaries'][0]['checklistCounts']['unverified'], 1)
        self.assertIn('review-queue package --event event-0', ready['packageSummaries'][0]['packageCommand'])
        package = self.ledger.verification_package('event-0')
        self.assertEqual(package['receipt']['checklist'][0]['evidence'], ['file:exact-evidence'])
        self.assertEqual(package['ownerInstructions']['authorization'], 'Read evidence only')
        self.assertIn('parent alone reviews/decides', package['instructions'][0])
        self.assertFalse(package['expectedOutput']['acceptedReview'])
        self.assertEqual(package['receiptLocator']['eventId'], 'event-0')

    def test_test_mode_persists_and_excluded_from_default_snapshots_metrics(self):
        self.receive()
        self.ledger = Ledger(self.tmp.name)
        self.ledger._receipt_now = self.iso
        self.assertTrue(self.ledger.receipt_test_mode)
        self.assertEqual(self.ledger.verification_snapshot()['jobs'], [])
        self.assertEqual(self.ledger.verification_metrics()['count'], 0)
        self.assertEqual(self.ledger.verification_metrics(include_test=True)['count'], 1)

    def test_metrics_distinguish_all_stages_missing_and_invalid_clock(self):
        self.receive()
        self.advance(1)
        claim = self.claim()
        self.advance(2)
        intent = self.start(claim, bound=False)
        self.advance(3)
        started = self.mutate('start', intent, dispatchId=intent['execution']['dispatch_id'], executionId='parent-native-claim')
        self.advance(4)
        done = self.submit(started)
        metrics = self.ledger.verification_metrics(include_test=True)
        sample = metrics['samples'][0]
        self.assertEqual(sample['receivedAt'], '2026-11-02T17:00:00.000000+00:00')
        self.assertEqual(sample['firstClaimAt'], '2026-11-02T17:00:01.000000+00:00')
        self.assertEqual(sample['parentDispatchRecordedAt'], '2026-11-02T17:00:03.000000+00:00')
        self.assertEqual(sample['parentStartRecordedAt'], '2026-11-02T17:00:06.000000+00:00')
        self.assertEqual(sample['candidateFinishedAt'], '2026-11-02T17:00:10.000000+00:00')
        for stage in ('wakeMarkerVerifiedAt','controllerReceiptReviewAt','decisionAt','executionConfirmedAt','verifiedAt'):
            self.assertIsNone(sample[stage])
        self.assertEqual(metrics['metrics']['receivedToFirstClaimAtSeconds']['count'], 1)
        self.assertEqual(metrics['metrics']['receivedToDecisionAtSeconds']['missing'], 1)
        with self.ledger._receipt_tx() as conn:
            conn.execute("UPDATE verification_jobs SET first_claim_at='2026-11-02T16:00:00+00:00'")
        invalid = self.ledger.verification_metrics(include_test=True)['metrics']['receivedToFirstClaimAtSeconds']
        self.assertEqual(invalid['invalidClock'], 1)
        self.assertEqual(invalid['count'], 0)
        self.assertIsNone(invalid['mean'])

    def test_metrics_controller_history_separates_execution_receive_confirmation_and_verify(self):
        self.receive()
        self.advance(1)
        self.ledger.review_receipt('event-0', dict(reviewId='parent-review', result='accepted',
                                   evidence=['file:parent-independent-review']), actor_id=PARENT)
        self.advance(1)
        decision = self.ledger.create_decision(dict(decisionId='controller-decision', receiptId='event-0', taskId='T022',
            stageId='candidate-stage', sessionId='queue-worker', turnId='turn-event-0', decisionRequired=True,
            authority='controller', trigger='Parent independently reviewed', options=['accept', 'rework'],
            owner='queue-worker', dueAt=None), actor_id=PARENT)
        def update(action, **kwargs):
            current = self.ledger.get_decision('controller-decision')
            return self.ledger.update_decision('controller-decision', dict(action=action,
                        expectedRevision=current['revision'], **kwargs), actor_id=PARENT)
        self.advance(1)
        update('choose', choice='accept', reason='Parent decision', nextAction='Execute authorized candidate', decidedBy=PARENT)
        self.advance(1); update('action')
        self.advance(1)
        data = dict(eventId='execution', taskId='T022', sessionId='queue-worker', turnId='execution-turn',
                    kind='delivery', occurredAt=self.iso(), checklist=[dict(requirement='Executed', status='pass',
                    evidence=['file:execution'])], limitations=[], summary='Execution receipt', source='queue-worker')
        self.ledger.receive_receipt(data)
        self.advance(1); update('execution-confirm', executionReceiptId='execution', evidence=['file:parent-confirmation'])
        self.advance(1); update('verify', evidence=['file:parent-verification'])
        self.assertEqual(self.get('execution')['state'], 'controller-reviewed')
        sample = next(s for s in self.ledger.verification_metrics(include_test=True)['samples'] if s['eventId'] == 'event-0')
        self.assertEqual(sample['controllerReceiptReviewAt'], '2026-11-02T17:00:01.000000+00:00')
        self.assertEqual(sample['decisionCreatedAt'], '2026-11-02T17:00:02.000000+00:00')
        self.assertEqual(sample['decisionAt'], '2026-11-02T17:00:03.000000+00:00')
        self.assertEqual(sample['executionConfirmedAt'], '2026-11-02T17:00:05.000000+00:00')
        self.assertEqual(sample['executionConfirmationRecordedAt'], '2026-11-02T17:00:06.000000+00:00')
        self.assertEqual(sample['verifiedAt'], '2026-11-02T17:00:07.000000+00:00')
        self.assertIsNone(sample['candidateFinishedAt'])  # Direct controller review never fabricates a candidate.
        self.advance(1); update('rework', reason='New cycle', evidence=['file:rework'])
        after = next(s for s in self.ledger.verification_metrics(include_test=True)['samples'] if s['eventId'] == 'event-0')
        self.assertEqual(after['verifiedAt'], sample['verifiedAt'])

    def test_nonblocking_receive_while_existing_wake_stalls_and_receiver_never_calls_wake(self):
        self.ledger.set_meta('receipt_native_wake_enabled', '1')
        entered = threading.Event(); release = threading.Event()
        class BlockingWake(FakeWake):
            def send(self, event):
                entered.set(); release.wait(timeout=3)
                return Outcome('sent', 'test-read-marker', 'test-native-turn')
        wake = BlockingWake()
        self.receive('slow')
        with ThreadPoolExecutor(max_workers=2) as executor:
            future = executor.submit(self.ledger.dispatch_wake, 'slow', wake)
            try:
                self.assertTrue(entered.wait(timeout=2))
                self.ledger.wake_adapter = wake
                self.receive('fast')
                self.assertFalse(future.done())
                saved = self.ledger.get_receipt('fast')
                payload = {key: saved[key] for key in ('eventId','taskId','sessionId','turnId','kind','occurredAt','checklist','limitations','summary','source')}
                ack = LedgerReceiver(self.ledger).receive_receipt(payload)
                self.assertEqual(ack['wakeMode'], 'durable')
                self.assertNotIn('wake', ack)
                self.assertEqual(self.ledger.delivery_status('fast', queue='wake')['attempts'], 0)
            finally:
                release.set()
                future.result(timeout=3)

    def test_candidates_never_review_decide_or_accept_and_payloads_reject_authority_fields(self):
        self.receive()
        run = self.start(self.claim())
        with self.assertRaises(ValidationError):
            self.submit(run, acceptedReview=True)
        with patch.object(self.ledger, 'review_receipt', side_effect=AssertionError('forbidden review')), \
             patch.object(self.ledger, 'update_decision', side_effect=AssertionError('forbidden decision')):
            self.submit(run)
        with self.ledger._receipt_tx(False) as conn:
            for table in ('receipt_reviews', 'decisions'):
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0], 0)
        with self.assertRaises(TransitionError):
            self.ledger.verification('claim', dict(owner='worker'), actor_id='queue-worker')

    def test_cli_packages_claim_and_submission_contract(self):
        self.receive()
        path = Path(self.tmp.name) / 'claim.json'
        path.write_text(json.dumps(dict(owner='cli-parent')))
        def cli(*arguments):
            stream = io.StringIO()
            with redirect_stdout(stream):
                code = main(['--state', self.tmp.name, 'review-queue', *arguments])
            self.assertEqual(code, 0)
            return json.loads(stream.getvalue())
        package = cli('package', '--event', 'event-0')
        self.assertEqual(package['receiptLocator']['eventId'], 'event-0')
        self.assertEqual(cli('list')['jobs'], [])
        self.assertEqual(cli('ready', '--include-test')['summary']['count'], 1)
        claim = cli('claim', '--json', str(path), '--actor', PARENT)
        self.assertEqual(claim['state'], 'claimed')
        self.assertEqual(cli('metrics', '--include-test')['count'], 1)

    def test_reopen_migrates_unreviewed_legacy_receipts_without_queueing_reviewed(self):
        self.receive('unreviewed'); self.receive('reviewed')
        self.ledger.review_receipt('reviewed', dict(reviewId='legacy-review', result='accepted',
                                   evidence=['file:parent-review']), actor_id=PARENT)
        with self.ledger._receipt_tx() as conn:
            conn.execute('DELETE FROM verification_history')
            conn.execute('DELETE FROM verification_jobs')
            conn.execute("DELETE FROM meta WHERE key='verification_schema'")
        reopened = Ledger(self.tmp.name)
        jobs = reopened.verification_snapshot(include_test=True)['jobs']
        self.assertEqual([job['eventId'] for job in jobs], ['unreviewed'])
        self.assertEqual(len(reopened.get_receipt('reviewed')['reviews']), 1)


if __name__ == '__main__':
    unittest.main()

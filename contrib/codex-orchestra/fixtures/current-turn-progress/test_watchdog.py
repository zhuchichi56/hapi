"""Watchdog tests: pure evaluation, gate, mode, failure handling, handoff. No native call."""

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from . import watchdog as wd
from .constants import CONTROLLER_THREAD_ID
from .errors import ValidationError
from .ledger import Ledger

T0 = datetime(2026, 11, 4, 6, 0, tzinfo=timezone.utc)


def iso(dt):
    return dt.isoformat(timespec='seconds')


def task(tid, execution='running', review='pending', archive='none', expected=None, source=None, thread=None, turn=None):
    return dict(id=tid, title='任务 ' + tid, execution=execution, review=review, archive=archive,
                expectedAt=iso(expected) if expected else None, sourceAt=iso(source) if source else None,
                observedAt=iso(source) if source else None, threadId=thread, deliveryTurnId=turn)


def snap(tasks=(), receipts=()):
    return dict(tasks=list(tasks), receiptReviewBacklog=dict(count=len(receipts), receipts=list(receipts)))


def receipt(rid, kind, task_id, at):
    return dict(receiptId=rid, kind=kind, taskId=task_id, receivedAt=iso(at))


class FakeClient:
    def __init__(self, outcomes=None):
        self.sent = []
        self.outcomes = list(outcomes or [])
        self.marker_turn = None
        self.turn_state = 'completed'

    def send(self, thread_id, marker, text, action_id):
        self.sent.append((thread_id, marker, text, action_id))
        outcome = self.outcomes.pop(0) if (self.outcomes and thread_id == CONTROLLER_THREAD_ID) else 'sent'
        return outcome, 'fake-' + outcome, ('turn-%d' % len(self.sent) if outcome == 'sent' else None)

    def find_marker(self, thread_id, marker):
        return self.marker_turn

    def turn_status(self, thread_id, turn_id):
        return self.turn_state


class EvaluateTests(unittest.TestCase):
    enabled = T0 - timedelta(days=1)

    def ev(self, snapshot, now=T0, enabled=None, sources=None):
        return {e.key: e for e in wd.evaluate(snapshot, now, enabled_at=enabled or self.enabled, sources=sources)}

    def test_overdue_undelivered_is_p0_and_queued_is_p1(self):
        out = self.ev(snap([task('A', 'running', expected=T0 - timedelta(hours=2), source=T0),
                            task('B', 'queued', expected=T0 - timedelta(hours=2))]))
        self.assertEqual({e.kind: e.priority for e in out.values()}, {'overdue': wd.P0, 'undispatched': wd.P1})

    def test_stalled_running_task_is_p0_and_never_legacy(self):
        out = self.ev(snap([task('A', 'running', source=T0 - timedelta(minutes=45))]), enabled=T0 + timedelta(days=1))
        (event,) = out.values()
        self.assertEqual((event.kind, event.priority, event.legacy), ('stalled', wd.P0, False))

    def test_fresh_running_task_is_quiet(self):
        self.assertEqual(self.ev(snap([task('A', 'running', source=T0 - timedelta(minutes=5), expected=T0 + timedelta(hours=1))])), {})

    def test_terminal_and_closed_stage_are_ignored(self):
        past = T0 - timedelta(days=3)
        out = self.ev(snap([task('A', 'reported', 'accepted', expected=past), task('B', 'interrupted', archive='archived', expected=past),
                            task('C', 'reported', 'rejected', expected=past, source=past)]))
        self.assertEqual(out, {})

    def test_review_waiting_after_window(self):
        old = T0 - timedelta(hours=3)
        young = T0 - timedelta(seconds=30)
        out = self.ev(snap([task('A', 'reported', 'awaiting', source=old, turn='t1'), task('B', 'reported', 'awaiting', source=young)]))
        self.assertEqual([e.task_id for e in out.values()], ['A'])
        self.assertEqual(list(out.values())[0].priority, wd.P1)

    def test_receipts_by_kind_and_age(self):
        out = self.ev(snap(receipts=[receipt('r1', 'blocked', 'A', T0 - timedelta(minutes=1)),
                                     receipt('r2', 'delivery', 'A', T0 - timedelta(seconds=30)),
                                     receipt('r3', 'delivery', 'A', T0 - timedelta(minutes=5))]))
        self.assertEqual({k: e.priority for k, e in out.items()}, {'receipt:r1': wd.P0, 'receipt:r3': wd.P1})

    def test_legacy_flag_uses_enabled_at(self):
        out = self.ev(snap([task('A', 'interrupted', expected=T0 - timedelta(days=2))]), enabled=T0 - timedelta(days=1))
        self.assertTrue(list(out.values())[0].legacy)
        out = self.ev(snap([task('A', 'interrupted', expected=T0 - timedelta(minutes=3))]), enabled=T0 - timedelta(days=1))
        self.assertFalse(list(out.values())[0].legacy)

    def test_external_source_activity_detects_stall(self):
        out = self.ev(snap([task('T026', 'queued')]), sources={'T026': T0 - timedelta(minutes=30)})
        self.assertEqual([e.kind for e in out.values()], ['stalled'])
        out = self.ev(snap([task('T026', 'queued')]), sources={'T026': T0 - timedelta(minutes=2)})
        self.assertEqual(out, {})

    def test_activity_flag(self):
        self.assertFalse(wd.snapshot_is_active(snap([task('A', 'reported', 'accepted'), task('B', 'queued')])))
        self.assertTrue(wd.snapshot_is_active(snap([task('A', 'running')])))
        self.assertTrue(wd.snapshot_is_active(snap(receipts=[receipt('r', 'delivery', 'A', T0)])))


class GateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='wd-test-')
        self.ledger = Ledger(self.tmp.name, test_mode=True)
        self.client = FakeClient()
        self.now = T0
        self.dog = wd.Watchdog(self.ledger, client=self.client, clock=lambda: self.now,
                               sources_path=os.path.join(self.tmp.name, 'none.json'))
        self.ledger.set_meta('wd_enabled_at', iso(T0 - timedelta(days=1)))

    def tearDown(self):
        self.tmp.cleanup()

    def tick(self, snapshot, advance=0):
        self.now += timedelta(seconds=advance)
        return self.dog.tick(self.now, snapshot)

    def batches(self):
        connection = self.ledger._connect()
        try:
            return [dict(r) for r in connection.execute('SELECT * FROM wd_batches ORDER BY created_at')]
        finally:
            connection.close()

    def wakes(self):
        return [item for item in self.client.sent if item[0] == CONTROLLER_THREAD_ID]

    def counter(self, name):
        return int(self.ledger.get_meta('wd_' + name) or 0)

    def p0(self, at=None):
        return snap([task('A', 'blocked', expected=(at or self.now) - timedelta(minutes=1), thread=None)])

    # -- modes
    def test_default_mode_is_observe_and_sends_nothing(self):
        self.assertEqual(self.dog.mode(), 'observe')
        result = self.tick(self.p0())
        self.assertEqual(result['batch']['status'], 'observed')
        self.assertEqual(self.client.sent, [])
        self.assertEqual(self.counter('observed_wakes'), 1)

    def test_off_mode_does_nothing_at_all(self):
        self.dog.set_mode('off')
        self.assertEqual(self.tick(self.p0()), dict(mode='off'))
        self.assertEqual(self.batches(), [])
        self.assertEqual(self.client.sent, [])
        self.assertEqual(self.counter('checks'), 0)

    def test_live_p0_wakes_controller_once(self):
        self.dog.set_mode('live')
        result = self.tick(self.p0())
        self.assertEqual(result['batch']['status'], 'pending')
        self.assertEqual(len(self.wakes()), 1)
        thread, marker, text, _ = self.wakes()[0]
        self.assertEqual(thread, CONTROLLER_THREAD_ID)
        self.assertTrue(text.startswith(marker + ' ') and marker.startswith('[orchestra-watchdog:'))
        self.assertIn('P0 1 项', text)
        self.assertIn('1. P0 A', text)          # the item itself is inline: no lookup needed
        self.assertIn('请逐项核验并决定', text)
        self.assertIn('watchdog-brief', text)
        self.tick(self.p0(), 60)
        self.assertEqual(len(self.wakes()), 1)
        self.assertEqual(self.counter('wakes'), 1)

    def test_live_allow_list_limits_real_sends(self):
        self.dog.set_mode('live', ['T026'])
        self.tick(self.p0())
        self.assertEqual(self.client.sent, [])
        self.dog.set_mode('live', ['A'])
        self.tick(self.p0(), 60)
        self.assertEqual(len(self.wakes()), 1)

    def test_going_live_redelivers_what_observe_mode_only_simulated(self):
        rs = [receipt('r1', 'delivery', 'A', T0 - timedelta(hours=2))]
        self.tick(snap(receipts=rs))
        self.tick(snap(receipts=rs), wd.MERGE_WINDOW_SECONDS + 1)           # observe: counted as woken, nothing sent
        self.assertEqual(self.client.sent, [])
        self.assertEqual(self.counter('observed_wakes'), 1)
        self.dog.set_mode('live')
        result = self.tick(snap(receipts=rs), wd.MERGE_WINDOW_SECONDS + 1)
        self.assertEqual(result['batch']['p1'], 1)
        self.assertEqual(len(self.wakes()), 1)                              # the simulated item reaches the controller once
        self.dog.set_mode('live')                                           # setting live again must not resend a sent batch
        self.tick(snap(receipts=rs), wd.MIN_P1_GAP_SECONDS)
        self.assertEqual(len(self.wakes()), 1)

    # -- gate
    def test_p1_merges_into_one_wake_after_window(self):
        self.dog.set_mode('live')
        rs = [receipt('r%d' % i, 'delivery', 'A', T0 - timedelta(hours=2)) for i in range(3)]
        self.assertIsNone(self.tick(snap(receipts=rs))['batch'])
        self.assertIsNone(self.tick(snap(receipts=rs), wd.MERGE_WINDOW_SECONDS - 60)['batch'])   # still inside the window
        result = self.tick(snap(receipts=rs), 61)
        self.assertEqual((result['batch']['p1'], result['batch']['p0']), (3, 0))
        self.assertEqual(len(self.wakes()), 1)
        self.assertEqual(self.counter('silent'), 2)

    def test_p0_takes_p1_along_and_min_gap_defers_next_wake(self):
        self.dog.set_mode('live')
        rs = [receipt('r1', 'delivery', 'A', T0 - timedelta(hours=2))]
        first = self.tick(snap([task('A', 'blocked', expected=T0 - timedelta(minutes=1), thread=None)], rs))
        self.assertEqual((first['batch']['p0'], first['batch']['p1']), (1, 1))
        later = snap([task('A', 'blocked', expected=T0 - timedelta(minutes=1), thread=None),
                      task('B', 'failed', expected=self.now - timedelta(minutes=1), thread=None)], rs)
        self.assertIsNone(self.tick(later, 120)['batch'])
        self.assertEqual(self.tick(later, 200)['batch']['p0'], 1)

    def test_hourly_cap_suppresses_and_counts(self):
        self.dog.set_mode('live')
        for index in range(wd.MAX_WAKES_PER_HOUR):
            self.tick(snap([task('X%d' % index, 'blocked', expected=self.now - timedelta(minutes=1), thread=None)]), wd.MIN_WAKE_GAP_SECONDS + 1 if index else 0)
        sent = len(self.wakes())
        self.assertEqual(sent, wd.MAX_WAKES_PER_HOUR)
        self.tick(snap([task('Z', 'blocked', expected=self.now - timedelta(minutes=1), thread=None)]), wd.MIN_WAKE_GAP_SECONDS + 1)
        self.assertEqual(len(self.wakes()), sent)
        self.assertEqual(self.counter('suppressed'), 1)

    def test_legacy_items_are_one_digest_and_never_reminded(self):
        self.dog.set_mode('live')
        old = [task('L%d' % i, 'interrupted', expected=T0 - timedelta(days=2), thread=None) for i in range(17)]
        self.ledger.set_meta('wd_enabled_at', iso(T0))
        self.assertIsNone(self.tick(snap(old))['batch'])
        result = self.tick(snap(old), wd.MERGE_WINDOW_SECONDS + 1)
        self.assertEqual((result['batch']['legacy'], result['batch']['p0']), (17, 0))
        self.assertEqual(len(self.client.sent), 1)
        self.assertEqual(self.client.sent[0][1].split(':')[0], '[orchestra-watchdog')
        for _ in range(3):
            self.assertIsNone(self.tick(snap(old), wd.REMIND_SECONDS + 1)['batch'])
        self.assertEqual(len(self.wakes()), 1)

    def test_reminders_are_p1_back_off_and_stop(self):
        self.dog.set_mode('live')
        state = snap([task('A', 'blocked', expected=T0 - timedelta(minutes=1), thread=None)])
        self.assertEqual(self.tick(state)['batch']['p0'], 1)
        self.assertIsNone(self.tick(state, wd.REMIND_SECONDS - 100)['batch'])
        first = self.tick(state, 200)['batch']
        self.assertEqual((first['p0'], first['p1']), (0, 1))          # reminder 1 after 2h, as P1
        self.assertIsNone(self.tick(state, wd.REMIND_SECONDS * 2 - 100)['batch'])
        self.assertIsNotNone(self.tick(state, 200)['batch'])           # reminder 2 after 4h
        self.assertIsNone(self.tick(state, wd.REMIND_SECONDS * 4 - 100)['batch'])
        self.assertIsNotNone(self.tick(state, 200)['batch'])           # reminder 3 after 8h
        self.assertIsNone(self.tick(state, wd.MAX_REMIND_SECONDS * 2)['batch'])  # then quiet

    def test_p1_only_batches_keep_a_30_minute_gap(self):
        self.dog.set_mode('live')
        first = [receipt('a', 'delivery', 'A', T0 - timedelta(hours=2))]
        self.tick(snap(receipts=first), 0)
        self.tick(snap(receipts=first), wd.MERGE_WINDOW_SECONDS + 1)
        self.assertEqual(len(self.wakes()), 1)
        second = first + [receipt('b', 'delivery', 'B', self.now - timedelta(hours=2))]
        self.assertIsNone(self.tick(snap(receipts=second), wd.MERGE_WINDOW_SECONDS + 1)['batch'])
        self.assertIsNotNone(self.tick(snap(receipts=second), wd.MIN_P1_GAP_SECONDS)['batch'])

    def test_condition_clearing_before_wake_is_silent(self):
        rs = [receipt('r1', 'delivery', 'A', T0 - timedelta(hours=2))]
        self.dog.set_mode('live')
        self.tick(snap(receipts=rs))
        self.tick(snap(), 60)
        self.assertEqual(self.counter('silent'), 1)
        self.assertEqual(self.client.sent, [])

    def test_all_terminal_is_idle_and_slows_down(self):
        result = self.tick(snap([task('A', 'reported', 'accepted'), task('B', 'reported', 'accepted', archive='archived')]))
        self.assertFalse(result['active'])
        self.assertEqual(result['events'], 0)
        self.assertEqual(self.dog.next_delay(result), wd.TICK_SECONDS * wd.IDLE_TICK_FACTOR)
        self.assertEqual(self.dog.next_delay(dict(active=True)), wd.TICK_SECONDS)

    def test_items_inline_capped_with_overflow_note(self):
        self.dog.set_mode('live')
        many = snap([task('X%d' % i, 'blocked', expected=self.now - timedelta(minutes=1), thread=None) for i in range(9)])
        result = self.tick(many)
        text = self.wakes()[0][2]
        lines = text.split('\n')
        self.assertTrue(lines[0].startswith('[orchestra-watchdog:%s] ' % result['batch']['batchId']))
        self.assertEqual(len([l for l in lines if l[:2].rstrip('.').isdigit()]), wd.INLINE_ITEMS)
        self.assertIn('另有 3 项见清单', text)
        self.assertTrue(all(len(l) <= wd.INLINE_ITEM_CHARS for l in lines[1:-1]))

    # -- did the controller run the wake turn?
    def test_completed_wake_turn_is_effective(self):
        self.dog.set_mode('live')
        state = self.p0()
        self.tick(state)
        self.tick(state, wd.EFFECT_SETTLE_SECONDS + 5)
        block = wd.summary(self.ledger)
        self.assertEqual((block['controller'], block['wakesOk'], block['wakesFailed']), ('responsive', 1, None))

    def test_failed_wake_turn_reopens_events_slows_down_and_is_visible(self):
        self.dog.set_mode('live')
        self.client.turn_state = 'failed'
        state = self.p0()
        self.tick(state)
        self.assertEqual(len(self.wakes()), 1)
        self.tick(state, wd.EFFECT_SETTLE_SECONDS + 5)
        block = wd.summary(self.ledger)
        self.assertEqual((block['controller'], block['wakesFailed']), ('failing', 1))
        connection = self.ledger._connect()
        try:
            status = connection.execute("SELECT status,batch_id FROM wd_events WHERE task_id='A'").fetchone()
        finally:
            connection.close()
        self.assertEqual((status['status'], status['batch_id']), ('open', None))   # not treated as handled
        self.tick(state, wd.MIN_WAKE_GAP_SECONDS + 10)
        self.assertEqual(len(self.wakes()), 1)                                    # slowed: no call into the void
        self.client.turn_state = 'completed'
        self.tick(state, wd.FAILING_GAP_SECONDS)
        self.assertEqual(len(self.wakes()), 2)                                    # retried after the longer gap
        self.tick(state, wd.EFFECT_SETTLE_SECONDS + 5)
        self.assertEqual(wd.summary(self.ledger)['controller'], 'responsive')

    def test_repeated_failures_back_off_then_stop_for_a_day(self):
        self.dog.set_mode('live')
        self.client.turn_state = 'failed'
        state = self.p0()
        self.tick(state)
        self.tick(state, wd.EFFECT_SETTLE_SECONDS + 5)                      # failure 1
        gaps = [wd.FAILING_GAP_SECONDS, wd.FAILING_GAP_SECONDS * 2, wd.FAILING_GAP_SECONDS * 4]
        for wake_number, gap in enumerate(gaps, start=2):
            self.tick(state, gap - 60 - wd.EFFECT_SETTLE_SECONDS)
            self.assertEqual(len(self.wakes()), wake_number - 1)            # still inside the backoff window
            self.tick(state, 120)
            self.assertEqual(len(self.wakes()), wake_number)                # next call after 30 min, 1 h, 2 h
            self.tick(state, wd.EFFECT_SETTLE_SECONDS + 5)
        self.assertEqual(self.dog.consecutive_failures(), 4)
        self.tick(state, wd.FAILING_MAX_GAP_SECONDS * 2)
        self.assertEqual(len(self.wakes()), 4)                              # four failures: left alone for a day
        self.tick(state, wd.FAILING_STOP_GAP_SECONDS)
        self.assertEqual(len(self.wakes()), 5)

    def test_one_completed_wake_resets_the_failure_count(self):
        self.dog.set_mode('live')
        self.client.turn_state = 'failed'
        state = self.p0()
        self.tick(state)
        self.tick(state, wd.EFFECT_SETTLE_SECONDS + 5)
        self.assertEqual(self.dog.consecutive_failures(), 1)
        self.client.turn_state = 'completed'
        self.tick(state, wd.FAILING_GAP_SECONDS)
        self.tick(state, wd.EFFECT_SETTLE_SECONDS + 5)
        self.assertEqual((self.dog.consecutive_failures(), wd.summary(self.ledger)['controller']), (0, 'responsive'))

    def test_a_new_controller_thread_starts_with_a_clean_failure_record(self):
        from unittest import mock
        self.dog.set_mode('live')
        self.client.turn_state = 'failed'
        state = self.p0()
        self.tick(state)
        self.tick(state, wd.EFFECT_SETTLE_SECONDS + 5)
        self.assertEqual(self.dog.controller_state(), 'failing')
        self.assertEqual(wd.summary(self.ledger)['controller'], 'failing')
        with mock.patch.object(wd, 'CONTROLLER_THREAD_ID', 'new-controller-thread'):
            self.client.turn_state = 'completed'
            self.tick(state, 60)                                           # first tick after the switch
            self.assertIsNone(self.dog.controller_state())
            self.assertEqual(self.dog.consecutive_failures(), 0)
            self.assertIsNone(wd.summary(self.ledger)['controller'])
            self.tick(state, wd.MIN_WAKE_GAP_SECONDS + 10)                  # not held back by the old thread's failures
            self.assertEqual(self.client.sent[-1][0], 'new-controller-thread')

    def test_running_wake_turn_is_waited_for_then_given_up_as_unknown(self):
        self.dog.set_mode('live')
        self.client.turn_state = 'inProgress'
        state = self.p0()
        self.tick(state)
        self.tick(state, 120)
        self.assertIsNone(wd.summary(self.ledger)['controller'])
        self.client.turn_state = None
        self.tick(state, wd.EFFECT_GIVE_UP_SECONDS)
        block = wd.summary(self.ledger)
        self.assertIsNone(block['controller'])
        self.assertIsNone(block['wakesFailed'])

    def test_observe_mode_never_audits_or_slows(self):
        self.client.turn_state = 'failed'
        self.tick(self.p0())
        self.assertIsNone(wd.summary(self.ledger)['controller'])

    # -- failure handling
    def test_not_sent_retries_with_backoff_then_fails_and_reopens(self):
        self.dog.set_mode('live')
        self.client.outcomes = ['not-sent'] * 5
        state = self.p0()
        self.tick(state)
        self.assertEqual(len(self.wakes()), 1)
        self.tick(state, 30)
        self.assertEqual(len(self.wakes()), 1)  # backoff not elapsed
        self.tick(state, 200)
        self.tick(state, 400)
        first = self.batches()[0]
        self.assertEqual((first['status'], first['attempts']), ('failed', wd.MAX_SEND_ATTEMPTS))
        self.assertEqual(len(self.batches()), 2)  # events reopened into a fresh batch

    def test_unknown_blocks_new_batch_until_marker_found(self):
        self.dog.set_mode('live')
        self.client.outcomes = ['unknown']
        state = self.p0()
        self.tick(state)
        self.assertEqual(self.batches()[0]['status'], 'unknown')
        self.client.marker_turn = None
        self.tick(state, 120)
        self.assertEqual(len(self.wakes()), 1)
        self.client.marker_turn = 'native-turn-9'
        self.tick(state, 120)
        self.assertEqual(self.batches()[0]['status'], 'sent')
        self.assertEqual(self.batches()[0]['native_turn_id'], 'native-turn-9')
        self.assertEqual(len(self.wakes()), 1)

    def test_unknown_without_marker_becomes_lost_and_events_reopen(self):
        self.dog.set_mode('live')
        self.client.outcomes = ['unknown']
        state = self.p0()
        self.tick(state)
        self.tick(state, wd.UNKNOWN_BATCH_SECONDS + 10)
        self.assertEqual(self.batches()[0]['status'], 'lost')
        self.assertEqual(len(self.batches()), 2)  # events reopened into a fresh batch

    # -- forced handoff
    def test_overdue_handoff_is_sent_once_then_escalates_when_ignored(self):
        self.dog.set_mode('live')
        state = snap([task('A', 'running', expected=T0 - timedelta(minutes=5), source=T0, thread='worker-a')])
        self.tick(state)
        handoffs = [s for s in self.client.sent if s[1] == '[orchestra-timeout:A]']
        self.assertEqual(len(handoffs), 1)
        self.assertEqual(handoffs[0][0], 'worker-a')
        self.assertIn('不再延期', handoffs[0][2])
        later = snap([task('A', 'running', expected=T0 - timedelta(minutes=5), source=self.now + timedelta(seconds=wd.HANDOFF_GRACE_SECONDS), thread='worker-a')])
        self.tick(later, wd.HANDOFF_GRACE_SECONDS + 5)
        self.assertEqual(len([s for s in self.client.sent if s[1] == '[orchestra-timeout:A]']), 1)
        connection = self.ledger._connect()
        try:
            missed = connection.execute("SELECT detail FROM wd_events WHERE kind='handoff-missed'").fetchall()
        finally:
            connection.close()
        self.assertEqual(len(missed), 1)

    def test_handoff_not_sent_in_observe_mode_or_for_other_tasks(self):
        state = snap([task('A', 'running', expected=T0 - timedelta(minutes=5), source=T0, thread='worker-a')])
        self.tick(state)
        self.assertEqual(self.client.sent, [])
        self.dog.set_mode('live', ['B'])
        self.tick(state, 5)
        self.assertEqual([s for s in self.client.sent if s[1].startswith('[orchestra-timeout')], [])

    def test_delivery_cancels_handoff_escalation(self):
        self.dog.set_mode('live')
        overdue = snap([task('A', 'running', expected=T0 - timedelta(minutes=5), source=T0, thread='worker-a')])
        self.tick(overdue)
        delivered = snap([task('A', 'reported', 'awaiting', expected=T0 - timedelta(minutes=5), source=self.now, thread='worker-a')])
        self.tick(delivered, wd.HANDOFF_GRACE_SECONDS + 5)
        connection = self.ledger._connect()
        try:
            n = connection.execute("SELECT COUNT(*) FROM wd_events WHERE kind='handoff-missed'").fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(n, 0)

    # -- read-only views
    def test_summary_is_unknown_before_first_check(self):
        fresh = Ledger(tempfile.mkdtemp(prefix='wd-fresh-'), test_mode=True)
        block = wd.summary(fresh)
        self.assertEqual((block['mode'], block['checks'], block['wakes'], block['lastCheckAt']), ('observe', None, None, None))

    def test_brief_lists_one_line_per_item(self):
        self.dog.set_mode('live')
        result = self.tick(self.p0())
        text = wd.brief(self.ledger, result['batch']['batchId'])
        self.assertEqual(len(text['items']), 1)
        self.assertTrue(text['items'][0].startswith('P0 A '))
        with self.assertRaises(ValidationError):
            wd.brief(self.ledger, 'wd-unknown')

    def test_sources_file_feeds_external_stall(self):
        path = os.path.join(self.tmp.name, 'transcript.jsonl')
        with open(path, 'w') as handle:
            handle.write('{}')
        stamp = (self.now - timedelta(minutes=40)).timestamp()
        os.utime(path, (stamp, stamp))
        src = os.path.join(self.tmp.name, 'sources.json')
        with open(src, 'w') as handle:
            json.dump({'T026': {'kind': 'file-mtime', 'path': path}}, handle)
        dog = wd.Watchdog(self.ledger, client=self.client, clock=lambda: self.now, sources_path=src)
        result = dog.tick(self.now, snap([task('T026', 'queued', expected=self.now + timedelta(hours=1))]))
        self.assertEqual(result['events'], 1)
        self.assertEqual(result['batch']['p0'], 1)


class WatchOnlyTests(unittest.TestCase):
    """A CLI conversation with no ledger row: transcript mtime = progress, doneFile = delivered."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='wd-watch-')
        self.ledger = Ledger(self.tmp.name, test_mode=True)
        self.now = T0
        self.client = FakeClient()
        self.log = os.path.join(self.tmp.name, 'session.jsonl')
        with open(self.log, 'w') as handle:
            handle.write('{}')
        self.spec = {'T026': dict(kind='file-mtime', path=self.log, title='总控 P0', expectedAt=iso(T0 + timedelta(hours=2)),
                                  doneFile=os.path.join(self.tmp.name, 'T026.done'),
                                  acceptedFile=os.path.join(self.tmp.name, 'T026.accepted'))}
        self.write_sources()
        self.dog = wd.Watchdog(self.ledger, client=self.client, clock=lambda: self.now,
                               sources_path=os.path.join(self.tmp.name, 'sources.json'))
        self.ledger.set_meta('wd_enabled_at', iso(T0 - timedelta(days=1)))
        self.dog.set_mode('live', ['T026'])

    def tearDown(self):
        self.tmp.cleanup()

    def write_sources(self):
        with open(os.path.join(self.tmp.name, 'sources.json'), 'w') as handle:
            json.dump(self.spec, handle)

    def touch(self, path, at):
        with open(path, 'a'):
            pass
        os.utime(path, (at.timestamp(), at.timestamp()))

    def tick(self, advance=0):
        self.now += timedelta(seconds=advance)
        return self.dog.tick(self.now, snap())

    def wakes(self):
        return [s for s in self.client.sent if s[0] == CONTROLLER_THREAD_ID]

    def test_progress_then_stall_then_done_then_accepted(self):
        self.touch(self.log, T0)
        self.assertIsNone(self.tick(0)['batch'])                       # fresh progress: quiet
        self.touch(self.log, self.now + timedelta(minutes=10))
        self.assertIsNone(self.tick(660)['batch'])                    # still moving: quiet
        stalled = self.tick(wd.STALL_SECONDS + 120)['batch']          # no writes for 20+ min
        self.assertEqual((stalled['p0'], stalled['p1']), (1, 0))
        self.assertEqual(len(self.wakes()), 1)
        self.touch(self.log, self.now + timedelta(seconds=10))
        self.touch(self.spec['T026']['doneFile'], self.now + timedelta(seconds=20))
        self.tick(30)                                                  # delivered, settling
        self.tick(wd.DELIVERY_SETTLE_SECONDS)                          # event recorded, merge window opens
        self.assertEqual(len(self.wakes()), 1)
        delivered = self.tick(wd.MIN_P1_GAP_SECONDS)['batch']          # window and P1 gap both elapsed
        self.assertEqual((delivered['p0'], delivered['p1']), (0, 1))
        self.touch(self.spec['T026']['acceptedFile'], self.now)
        result = self.tick(60)
        self.assertEqual(result['events'], 0)

    def test_overdue_watch_task_is_p0(self):
        self.touch(self.log, T0 + timedelta(hours=2, minutes=30))
        result = self.tick(3 * 3600)
        kinds = {e.kind for e in wd.evaluate(dict(tasks=self.dog._watch_tasks(set(), self.dog._sources()), receiptReviewBacklog={}), self.now,
                                             enabled_at=T0 - timedelta(days=1), sources=self.dog._sources())}
        self.assertIn('overdue', kinds)
        self.assertGreaterEqual(result['batch']['p0'], 1)

    def test_ledger_known_ids_are_not_duplicated(self):
        self.touch(self.log, T0)
        rows = self.dog._watch_tasks({'T026'}, self.dog._sources())
        self.assertEqual(rows, [])


class WakeClientTests(unittest.TestCase):
    """The bridge returns before the native thread shows the new user item; the client must read back more than once."""

    def make(self, visible_after):
        reads = {'n': 0}
        sleeps = []

        def post(command):
            if command['op'] == 'send':
                return 200, {'ok': True}
            reads['n'] += 1
            items = [{'role': 'user', 'text': '[orchestra-watchdog:b1] hello'}] if reads['n'] > visible_after else []
            return 200, {'ok': True, 'result': {'id': 'ctl', 'turns': [{'id': 'turn-7', 'items': items}]}}
        return wd.WakeClient(post=post, sleep=sleeps.append), reads, sleeps

    def test_sent_when_marker_appears_on_a_later_read(self):
        client, reads, sleeps = self.make(visible_after=2)
        self.assertEqual(client.send('ctl', '[orchestra-watchdog:b1]', 'x', 'a1'), ('sent', 'native-read-marker', 'turn-7'))
        self.assertEqual((reads['n'], len(sleeps)), (3, 2))

    def test_unknown_after_all_tries_never_not_sent(self):
        client, reads, _ = self.make(visible_after=99)
        self.assertEqual(client.send('ctl', '[orchestra-watchdog:b1]', 'x', 'a1'), ('unknown', 'native-read-unconfirmed', None))
        self.assertEqual(reads['n'], wd.READBACK_TRIES)


class LedgerTaskSignalTests(unittest.TestCase):
    """Poll time and same-thread rollout mtime cannot date current-turn activity."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='wd-ledger-signals-')
        self.ledger = Ledger(self.tmp.name, test_mode=True)
        self.now = T0
        self.client = FakeClient()
        self.root = os.path.join(self.tmp.name, 'codexhome')
        day = os.path.join(self.root, 'sessions', '2026', '11', '05')
        os.makedirs(day)
        self.day = day
        self.dog = wd.Watchdog(self.ledger, client=self.client, clock=lambda: self.now, sessions_root=self.root,
                               sources_path=os.path.join(self.tmp.name, 'none.json'))
        self.ledger.set_meta('wd_enabled_at', iso(T0 - timedelta(days=1)))
        self.dog.set_mode('live')

    def tearDown(self):
        self.tmp.cleanup()

    def rollout(self, thread, age_seconds):
        path = os.path.join(self.day, 'rollout-2026-11-05T00-00-00-%s.jsonl' % thread)
        with open(path, 'w') as handle:
            handle.write('{}')
        stamp = (self.now - timedelta(seconds=age_seconds)).timestamp()
        os.utime(path, (stamp, stamp))
        return path

    def test_awaiting_review_uses_the_delivery_in_history_not_observed_at(self):
        delivered = task('A', 'reported', 'awaiting', source=None)
        delivered['observedAt'] = iso(self.now)                                    # refreshed by the poll just now
        delivered['history'] = [dict(kind='delivery', createdAt=iso(self.now - timedelta(hours=3)))]
        result = self.dog.tick(self.now, snap([delivered]))
        self.assertEqual(result['events'], 1)
        self.assertEqual(wd.delivered_at(delivered), self.now - timedelta(hours=3))

    def test_fresh_delivery_waits_out_the_settle_time(self):
        delivered = task('A', 'reported', 'awaiting')
        delivered['history'] = [dict(kind='delivery', createdAt=iso(self.now - timedelta(seconds=30)))]
        self.assertEqual(self.dog.tick(self.now, snap([delivered]))['events'], 0)

    def test_old_same_thread_rollout_cannot_establish_current_turn_stall(self):
        running = task('A', 'running', thread='thread-a')
        running['observedAt'] = iso(self.now)
        self.rollout('thread-a', age_seconds=wd.STALL_SECONDS + 300)
        result = self.dog.tick(self.now, snap([running]))
        self.assertEqual(result['events'], 0)
        self.assertEqual(self.dog._thread_sources(snap([running]), self.now), {'A': None})

    def test_busy_unverified_rollout_also_leaves_current_turn_unknown(self):
        running = task('A', 'running', thread='thread-a')
        running['observedAt'] = iso(self.now)
        self.rollout('thread-a', age_seconds=30)
        self.assertEqual(self.dog.tick(self.now, snap([running]))['events'], 0)
        self.assertEqual(self.dog._thread_sources(snap([running]), self.now), {'A': None})

    def test_running_task_without_any_activity_signal_is_unknown_not_stalled(self):
        running = task('A', 'running', thread='thread-missing')
        running['observedAt'] = iso(self.now - timedelta(hours=2))                 # stale observedAt must not be read as a stall
        self.assertEqual(self.dog.tick(self.now, snap([running]))['events'], 0)


if __name__ == '__main__':
    unittest.main()

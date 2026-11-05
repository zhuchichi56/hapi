"""Current-turn activity regressions. Temporary ledger only; native read mocked."""

import copy
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from . import collector as col
from . import watchdog as wd
from .ledger import Ledger
from .test_watchdog import FakeClient, iso, snap, task

THREAD = '01a1770b-f079-7ba0-b128-b317f75fdaad'
TURN = '01a1a95a-8fd1-78b1-adce-685bf1b6f77d'
START = datetime(2026, 11, 5, 1, 37, 27, tzinfo=timezone.utc)
OLD = datetime.fromisoformat('2026-10-26T07:10:59.004524+00:00')


def native():
    return dict(ok=True, result=dict(
        id=THREAD, live=True, status='active', revision='view-1',
        turns=[dict(id='prior-turn', status='completed', items=[]),
               dict(id=TURN, status='inProgress', durationMs=10000, items=[
                   dict(id='tool-1', role='tool', status='completed',
                        text='synthetic tool output'),
                   dict(id='assistant-1', role='assistant', phase='commentary',
                        text='synthetic activity')])]))


class CurrentTurnProgressTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='current-turn-')
        self.addCleanup(self.tmp.cleanup)
        self.ledger = Ledger(self.tmp.name, test_mode=True)
        self.ledger.register(dict(id='T015', title='isolated fixture', threadId=THREAD,
                                  createdAt=iso(START), sourceAt=iso(OLD)))
        self.now = START + timedelta(seconds=10)
        self.payload = native()
        self.collector = col.Collector(self.ledger)
        self.addCleanup(self.collector.close)
        self.client = FakeClient()
        self.dog = self.make_dog()
        self.ledger.set_meta('wd_enabled_at', iso(START - timedelta(days=1)))

    def make_dog(self):
        return wd.Watchdog(self.ledger, client=self.client, clock=lambda: self.now,
                           sessions_root=os.path.join(self.tmp.name, 'codex'),
                           sources_path=os.path.join(self.tmp.name, 'none.json'))

    def poll(self, seconds=0):
        self.now += timedelta(seconds=seconds)
        with patch.object(col, 'read_thread', return_value=copy.deepcopy(self.payload)) as read:
            with patch.object(col, 'now_iso', return_value=iso(self.now)):
                result = self.collector._run_one(self.ledger.get_task('T015'))
                outcome = self.collector._apply(result)
        self.assertEqual(read.call_count, 1)
        self.assertTrue(outcome['applied'], outcome)
        return result

    def record(self):
        return json.loads(self.ledger.get_meta(col.native_progress_key('T015')))

    def view(self, source=None):
        row = task('T015', thread=THREAD, source=source)
        row['observedAt'] = iso(self.now)
        return snap([row])

    def tick(self, source=None):
        return self.dog.tick(self.now, self.view(source))

    def test_exact_false_stall_old_rollout_and_old_source_are_unknown(self):
        path = os.path.join(self.tmp.name, 'codex', 'sessions', '2026', '10', '26',
                            'rollout-2026-10-26T15-10-33-%s.jsonl' % THREAD)
        os.makedirs(os.path.dirname(path))
        with open(path, 'w') as handle:
            handle.write('{}')
        os.utime(path, (OLD.timestamp(), OLD.timestamp()))
        self.assertEqual((self.now - OLD).total_seconds() // 60, 14066)
        false_events = wd.evaluate(self.view(OLD), self.now, enabled_at=START,
                                   sources={'T015': OLD})
        self.assertEqual(false_events[0].detail, '14066 分钟无新进展')
        self.dog._record(false_events, self.now)
        self.poll()
        self.assertIsNone(self.record()['progressAt'])
        self.assertEqual(self.dog._thread_sources(self.view(OLD), self.now), {'T015': None})
        self.assertEqual(self.tick(OLD)['events'], 0)
        connection = self.ledger._connect()
        try:
            row = connection.execute('SELECT status FROM wd_events WHERE key=?',
                                     (false_events[0].key,)).fetchone()
            self.assertEqual(row['status'], 'resolved')  # history remains
        finally:
            connection.close()
        self.poll(1500)
        self.assertIsNone(self.record()['progressAt'])
        self.assertEqual(self.tick(OLD)['events'], 0)

    def test_tool_identity_status_phase_content_and_extent_date_activity(self):
        self.poll()
        changes = [lambda items: items.append(dict(id='tool-2', role='tool', status='running', text='')),
                   lambda items: items[-1].update(status='completed'),
                   lambda items: items[-1].update(text='x'),
                   lambda items: items[-1].update(text='y'),  # same extent, changed content
                   lambda items: items[-1].update(text='yz'),
                   lambda items: items[-1].update(outputLength=3000),
                   lambda items: items[1].update(phase='analysis'),
                   lambda items: items[1].update(text='more assistant content')]
        for change in changes:
            with self.subTest(change=changes.index(change)):
                change(self.payload['result']['turns'][-1]['items'])
                self.poll(5)
                self.assertEqual(self.record()['progressAt'], iso(self.now))
                self.assertEqual(self.tick()['events'], 0)
        encoded = self.ledger.get_meta(col.native_progress_key('T015'))
        self.assertLess(len(encoded), 700)
        for raw in ('synthetic tool output', 'more assistant content', 'tool-2'):
            self.assertNotIn(raw, encoded)

    def test_revision_duration_heartbeat_and_prior_turn_changes_do_not_progress(self):
        self.poll()
        self.payload['result']['turns'][-1]['items'][0]['text'] += '!'
        self.poll(5)
        progress = self.record()['progressAt']
        cursor = self.record()['cursor']
        entire_record = self.record()
        self.payload['result'].update(revision='view-2', observedAt=iso(self.now), totalItems=999)
        self.payload['result']['turns'][-1].update(durationMs=999999, observedAt=iso(self.now))
        self.payload['result']['turns'][0]['items'].append(dict(id='old-tool', role='tool', text='old'))
        self.poll(30)
        self.assertEqual((self.record()['progressAt'], self.record()['cursor']), (progress, cursor))
        self.poll(30)
        self.assertEqual(self.record()['progressAt'], progress)
        self.assertEqual(self.record(), entire_record)

    def test_restart_preserves_known_activity_and_baseline_unknown(self):
        self.poll()
        self.collector.close()
        self.collector = col.Collector(Ledger(self.tmp.name, test_mode=True))
        self.addCleanup(self.collector.close)
        self.poll(5)
        self.assertIsNone(self.record()['progressAt'])
        self.payload['result']['turns'][-1]['items'][0]['text'] += '!'
        self.poll(5)
        progress = self.record()['progressAt']
        self.collector.close()
        self.collector = col.Collector(Ledger(self.tmp.name, test_mode=True))
        self.addCleanup(self.collector.close)
        self.dog = self.make_dog()
        self.poll(wd.STALL_SECONDS + 1)
        self.assertEqual(self.record()['progressAt'], progress)
        self.assertEqual(self.tick()['events'], 1)

    def test_turn_and_thread_identity_do_not_inherit_progress(self):
        self.poll()
        self.payload['result']['turns'][-1]['items'][0]['text'] += '!'
        self.poll(5)
        previous = self.record()
        self.payload['result']['turns'][-1]['id'] = 'next-turn'
        self.poll(wd.STALL_SECONDS + 5)
        self.assertIsNone(self.record()['progressAt'])
        self.assertEqual(self.tick(OLD)['events'], 0)
        # Even a leftover valid record for another native turn/thread is UNKNOWN.
        for field in ('turnId', 'threadId'):
            bad = dict(previous)
            if field == 'threadId':
                bad['turnId'] = 'next-turn'
                bad[field] = 'other-thread'
            self.ledger.set_meta(col.native_progress_key('T015'), json.dumps(bad))
            self.assertEqual(self.tick(OLD)['events'], 0)

    def test_cessation_over_twenty_minutes_stalls_despite_fresh_poll(self):
        self.poll()
        self.payload['result']['turns'][-1]['items'].append(
            dict(id='tool-2', role='tool', status='completed', text='fresh activity'))
        self.poll(5)
        progress = self.now
        self.poll(wd.STALL_SECONDS)
        self.assertEqual(self.tick()['events'], 0)  # strictly >20 minutes
        self.payload['result']['revision'] = 'heartbeat-only'
        self.payload['result']['turns'][-1]['durationMs'] += 1000000
        self.poll(1)
        result = self.tick()
        self.assertEqual((result['events'], result['batch']['p0']), (1, 1))
        events = wd.evaluate(self.view(), self.now, enabled_at=START,
                             sources=self.dog._thread_sources(self.view(), self.now))
        self.assertEqual(events[0].kind, 'stalled')
        self.assertEqual(events[0].trigger_at, iso(progress + timedelta(seconds=wd.STALL_SECONDS)))
        self.assertEqual(datetime.fromisoformat(self.ledger.get_task('T015')['observed_at']), self.now)

    def test_missing_and_untrusted_state_are_unknown(self):
        self.assertEqual(self.tick(OLD)['events'], 0)
        for value in ('not-json', '[]', '{}', json.dumps(dict(version=1, threadId=THREAD,
                     turnId=TURN, cursor='x', progressAt='untrusted'))):
            self.ledger.set_meta(col.native_progress_key('T015'), value)
            self.assertEqual(self.tick(OLD)['events'], 0)
        self.poll()
        invalid_cursor = dict(self.record(), cursor='untrusted', progressAt=iso(OLD))
        self.ledger.set_meta(col.native_progress_key('T015'), json.dumps(invalid_cursor))
        self.poll(5)
        self.assertIsNone(self.record()['progressAt'])
        valid = self.record()
        for value in ('untrusted', '2099-01-01T00:00:00+00:00'):
            invalid = dict(valid, progressAt=value)
            self.ledger.set_meta(col.native_progress_key('T015'), json.dumps(invalid))
            self.assertEqual(self.tick(OLD)['events'], 0)
        self.ledger.set_meta(col.native_progress_key('T015'), json.dumps(valid))
        del self.payload['result']['turns'][-1]['items']
        self.poll(10)
        self.assertIsNone(self.record()['cursor'])
        self.assertIsNone(self.record()['progressAt'])
        self.assertEqual(self.tick(OLD)['events'], 0)
        self.payload['result']['turns'][-1]['items'] = []
        self.poll(10)
        self.assertIsNone(self.record()['progressAt'])

    def test_rejected_outdated_callback_cannot_advance_or_reset_cursor(self):
        older = self.poll()
        self.payload['result']['turns'][-1]['items'][0]['text'] += '!'
        self.poll(10)
        previous = self.record()
        self.assertFalse(self.collector._apply(older)['applied'])
        self.assertEqual(self.record(), previous)

    def test_injected_sanitized_observer_is_called_once_without_native_read(self):
        observation = dict(threadId=THREAD, turnId=TURN, turnStatus='inProgress',
                           live=True, status='active', revision='r1', assistantText='fixture')
        calls = []
        def observer(*args):
            calls.append(args)
            return dict(observation)
        injected = col.Collector(self.ledger, bridge_fn=observer, socket_path='fixture-socket', timeout=3)
        self.addCleanup(injected.close)
        with patch.object(col, 'read_thread', side_effect=AssertionError('unexpected native read')):
            for index in range(3):
                observation['revision'] = str(index)
                if index == 2:
                    observation['assistantText'] += '!'
                self.now += timedelta(seconds=5)
                with patch.object(col, 'now_iso', return_value=iso(self.now)):
                    result = injected._run_one(self.ledger.get_task('T015'))
                    self.assertTrue(injected._apply(result)['applied'])
                self.assertEqual(self.record()['progressAt'], iso(self.now) if index == 2 else None)
        self.assertEqual(calls, [(THREAD, 'fixture-socket', 3)] * 3)

    def test_unknown_does_not_mask_overdue_receipt_or_handoff(self):
        self.poll()
        row = self.view(OLD)['tasks'][0]
        row['expectedAt'] = iso(self.now - timedelta(seconds=1))
        view = snap([row], [dict(receiptId='isolated', kind='blocked', taskId='T015', receivedAt=iso(self.now))])
        sources = self.dog._thread_sources(view, self.now)
        events = wd.evaluate(view, self.now, enabled_at=START, sources=sources)
        self.assertEqual({e.kind for e in events}, {'overdue', 'receipt-p0'})
        self.dog.set_mode('live')
        result = self.dog.tick(self.now, view)
        self.assertTrue(result['handoffs'])
        self.assertEqual(result['batch']['p0'], 2)

    def test_completion_and_revision_polls_keep_one_delivery_notice_and_history(self):
        self.poll()
        self.payload['result'].update(live=False, status='idle')
        self.payload['result']['turns'][-1]['status'] = 'completed'
        self.payload['result']['turns'][-1]['items'].append(
            dict(id='final', role='assistant', phase='final_answer', text='fixture complete'))
        self.poll(5)
        self.assertEqual(self.ledger.get_task('T015')['execution'], 'reported')
        for index in range(2):
            self.payload['result']['revision'] = 'completion-poll-%d' % index
            self.poll(5)
        connection = self.ledger._connect()
        try:
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM notices WHERE task_id='T015' AND kind='delivery'"
            ).fetchone()[0], 1)
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM task_history WHERE task_id='T015' AND kind='delivery'"
            ).fetchone()[0], 1)
        finally:
            connection.close()


class WatchReviewClosureTests(unittest.TestCase):
    def test_phase_review_hook_closes_exact_stage_and_new_stage_remains_reviewable(self):
        from .constants import CONTROLLER_THREAD_ID
        from .watch_review import record

        with tempfile.TemporaryDirectory(prefix='watch-stage-') as root:
            ledger = Ledger(root, test_mode=True)
            specs = {}
            for tid in ('T026', 'T027'):
                watched, done = os.path.join(root, tid + '.log'), os.path.join(root, tid + '.done')
                for path in (watched, done):
                    with open(path, 'w') as handle:
                        handle.write('isolated evidence')
                    stamp = (START - timedelta(hours=1)).timestamp()
                    os.utime(path, (stamp, stamp))
                specs[tid] = dict(kind='file-mtime', path=watched, doneFile=done)
            with open(os.path.join(root, 'watchdog-sources.json'), 'w') as handle:
                json.dump(specs, handle)
            dog = wd.Watchdog(ledger, client=FakeClient(), clock=lambda: START)
            self.assertEqual(dog.tick(START, snap())['events'], 2)
            for tid, decision in (('T026', 'rejected'), ('T027', 'accepted')):
                record(ledger, tid, decision, 'isolated stage review', [specs[tid]['path']],
                       'fixture-review-' + tid, actor=CONTROLLER_THREAD_ID)
            self.assertEqual(dog.tick(START, snap())['events'], 0)
            # A different done marker identity reopens review; no global disable.
            path = specs['T026']['doneFile']
            stamp = (START - timedelta(minutes=30)).timestamp()
            os.utime(path, (stamp, stamp))
            self.assertEqual(dog.tick(START, snap())['events'], 1)


if __name__ == '__main__':
    unittest.main()

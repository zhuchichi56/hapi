"""Portable core checks: synthetic local state, no watchdog API or native calls."""
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from orchestra import Ledger
from orchestra.constants import CONTROLLER_THREAD_ID
from orchestra.errors import NotFoundError, TransitionError, ValidationError
from orchestra.watch_review import projection


class ReviewActorWatchCoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='synthetic-review-core-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.actor = 'synthetic-current-controller'
        self.ledger = Ledger(str(self.root / 'state'), controller_thread_id=self.actor, test_mode=True)
        self.when = datetime.now(timezone.utc).isoformat()
        self.ledger.register(dict(id='SYNTH-TASK', title='SYNTHETIC core task', threadId='synthetic-main'))
        self.ledger.apply_observation('SYNTH-TASK', dict(turnId='synthetic-delivery', turnStatus='completed'), self.when)
        self.activity = self.root / 'synthetic-activity.txt'
        self.activity.write_text('SYNTHETIC activity fixture')
        self.done = self.root / 'synthetic.done'
        self.evidence = self.root / 'synthetic-evidence.txt'
        self.evidence.write_text('SYNTHETIC evidence: remaining gap')
        self.accepted = self.root / 'synthetic.accepted'
        self.spec = dict(kind='file-mtime', path=str(self.activity), doneFile=str(self.done),
                         acceptedFile=str(self.accepted), goal='SYNTHETIC goal', gaps=['SYNTHETIC gap'])
        self.config = Path(self.ledger.state_dir) / 'watchdog-sources.json'
        self.config.write_text(json.dumps({'SYNTH-WATCH': self.spec}))

    def denied_before_connection(self, call):
        for kwargs in ({}, {'actor': 'synthetic-worker'}, {'actor': CONTROLLER_THREAD_ID}):
            with self.subTest(kwargs=kwargs), patch.object(self.ledger, '_connect', side_effect=AssertionError('unexpected connection')):
                with self.assertRaises(TransitionError):
                    call(**kwargs)

    def review_watch(self, **kwargs):
        return self.ledger.watch_review('SYNTH-WATCH', 'rejected', 'SYNTHETIC remaining gap',
                                        [str(self.evidence)], 'synthetic-watch-op', **kwargs)

    def test_task_current_instance_actor_and_idempotent_authorization(self):
        call = lambda **kwargs: self.ledger.review('SYNTH-TASK', 'accepted', 'SYNTHETIC evidence', 'synthetic-task-op', **kwargs)
        self.denied_before_connection(call)
        result = call(actor=self.actor)
        self.assertFalse(result['reused'])
        self.assertEqual(result['operation']['payload']['actor'], self.actor)
        self.assertTrue(call(actor=self.actor)['reused'])
        self.denied_before_connection(call)
        self.assertEqual(self.ledger.get_task('SYNTH-TASK')['review'], 'accepted')

    def test_session_actor_forwarding_and_idempotent_authorization(self):
        self.ledger.add_task_session('SYNTH-TASK', dict(sessionId='synthetic-role', threadId='synthetic-role-thread',
                                                       role='SYNTHETIC responsibility'), 'synthetic-session-add')
        for turn in ('synthetic-baseline', 'synthetic-session-delivery'):
            self.ledger.apply_session_observation('SYNTH-TASK', 'synthetic-role',
                                                  dict(turnId=turn, turnStatus='completed'), self.when)
        call = lambda **kwargs: self.ledger.review_session('SYNTH-TASK', 'synthetic-role', 'rejected',
                                                           'SYNTHETIC session gap', 'synthetic-session-op', **kwargs)
        self.denied_before_connection(call)
        result = call(actor=self.actor)
        self.assertEqual(result['review'], 'rejected')
        self.assertEqual(result['operation']['payload']['actor'], self.actor)
        self.assertTrue(call(actor=self.actor)['reused'])
        self.denied_before_connection(call)

    def test_watch_requires_source_delivery_actor_and_evidence(self):
        self.denied_before_connection(self.review_watch)
        with self.assertRaises(NotFoundError):
            self.ledger.watch_review('SYNTH-MISSING', 'accepted', 'SYNTHETIC', [str(self.evidence)], 'missing', actor=self.actor)
        with self.assertRaises(TransitionError):
            self.review_watch(actor=self.actor)
        self.done.write_text('SYNTHETIC delivered')
        for refs in ([], [str(self.root / 'missing')], [str(self.root)]):
            with self.assertRaises(ValidationError):
                self.ledger.watch_review('SYNTH-WATCH', 'rejected', 'SYNTHETIC gap', refs, 'bad-ref', actor=self.actor)
        with self.ledger._receipt_tx(write=False) as connection:
            self.assertIsNone(connection.execute("SELECT 1 FROM sqlite_master WHERE name='watch_reviews'").fetchone())

    def test_watch_rejection_durable_replay_new_stage_and_no_fake_rows(self):
        self.done.write_text('SYNTHETIC delivered')
        config_before = self.config.read_bytes()
        result = self.review_watch(actor=self.actor)
        self.assertFalse(result['reused'])
        self.assertEqual(result['decision']['evidence_ref'], [str(self.evidence)])
        self.assertEqual(result['decision']['actor'], self.actor)
        self.assertEqual(self.review_watch(actor=self.actor), dict(reused=True, decision=result['decision']))
        self.denied_before_connection(self.review_watch)
        with self.assertRaises(TransitionError):
            self.ledger.watch_review('SYNTH-WATCH', 'accepted', 'SYNTHETIC changed', [str(self.evidence)],
                                     'synthetic-watch-op', actor=self.actor)
        reopened = Ledger(self.ledger.state_dir, controller_thread_id=self.actor, test_mode=True)
        view = reopened.watch_review_status('SYNTH-WATCH')
        self.assertEqual((view['execution'], view['review']), ('reported', 'rejected'))
        self.assertEqual(view['decision'], result['decision'])
        self.assertIn('remaining gap', view['decision']['reason'])
        self.assertEqual(projection(reopened, 'SYNTH-WATCH', self.spec)['review'], 'rejected')
        self.assertIsNone(reopened.get_task('SYNTH-WATCH'))
        self.assertFalse(self.accepted.exists())
        self.assertEqual(self.config.read_bytes(), config_before)
        with reopened._receipt_tx(write=False) as connection:
            for table in ('task_sessions', 'receipts', 'receipt_reviews'):
                expected = 0
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0], expected)
        ns = self.done.stat().st_mtime_ns + 1
        os.utime(self.done, ns=(ns, ns))
        view = reopened.watch_review_status('SYNTH-WATCH')
        self.assertEqual(view['review'], 'awaiting')
        self.assertIsNone(view['decision'])
        self.assertEqual(view['latestDecision'], result['decision'])
        with self.assertRaises(TransitionError):
            self.review_watch(actor=self.actor)
        self.assertEqual(self.config.read_bytes(), config_before)


if __name__ == '__main__':
    unittest.main(verbosity=2)

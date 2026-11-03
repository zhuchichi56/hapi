"""Dispatch unit tests: fake launchers only, no model/network/native messages."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from . import silent_dispatch as dispatch
from .cli import main
from .constants import CONTROLLER_THREAD_ID
from .errors import TransitionError, ValidationError
from .ledger import Ledger
from .receipt_delivery import LedgerReceiver
from .receipt_recovery import ReceiptRecoveryCollector

ROOT = Path(__file__).parent
EVIDENCE = ROOT.parent / 'fixtures' / 'silent-dispatch'
DEAD_PID = 1073741823


class FakeChild:
    pid = DEAD_PID

    def __init__(self, code=None):
        self.code = code

    def poll(self):
        return self.code

    def wait(self, *args, **kwargs):
        raise AssertionError('collector must never wait for a launcher')


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='dispatch-test-', dir=ROOT)
        self.addCleanup(self.tmp.cleanup)
        self.now = datetime(2026, 11, 3, 14, tzinfo=timezone.utc)
        self.ledger = Ledger(self.tmp.name, test_mode=True)
        self.ledger._receipt_now = self.iso
        self.ledger.register(dict(id='T022', title='Existing project', threadId='worker-one',
            execution='running', goal='Registered goal', deliverables=['old output'],
            acceptance=['old acceptance'], ownership=['existing scope'], authorization='existing authority'))
        self.launches = []
        self.child = FakeChild()
        self.runner = dispatch.DispatchRunner(self.ledger, popen=self.launch)

    def iso(self):
        return self.now.isoformat(timespec='microseconds')

    def payload(self, request='request-one'):
        return dict(taskId='T022', requestId=request, goal='Increment goal',
            deliverables=['candidate.txt'], acceptance=['check candidate'], ownership=['WORKDIR only'],
            authorization='Fake tests only', deadline=(self.now + timedelta(hours=1)).isoformat())

    def submit(self, request='request-one'):
        return self.ledger.dispatch_submit(self.payload(request))

    def launch(self, argv, **kwargs):
        self.launches.append((argv, kwargs))
        # The FULL-sync intent must already be visible through another Ledger.
        other = Ledger(self.tmp.name, test_mode=True)
        op = other.dispatch_status('silent_dispatch:' + Path(kwargs['cwd']).name)
        self.assertEqual(op['payload']['launchAttempts'], 1)
        self.assertIsNotNone(op['payload']['timings']['launchStartedAt'])
        self.assertTrue((Path(kwargs['cwd']) / 'intent.json').exists())
        return self.child

    def start(self, request='request-one'):
        op = self.submit(request)
        self.runner.tick()
        return self.ledger.dispatch_status(op['opId'])

    def write_state(self, op, **changes):
        p = op['payload']
        work = Path(p['workdir'])
        state = dict(pid=DEAD_PID, running=False, failed=False, done=True, exit=0,
                     deadline_at=p['package']['deadline'])
        state.update(changes)
        (work / 'codex-state.json').write_text(json.dumps(state))
        manifest = dict(executor='codex', provider='copilot', base_url='http://127.0.0.1:4150/v1',
            model='gpt-6.1-sol', effort='high', max_rounds=1, workdir=str(work),
            brief=str(work / 'BRIEF.md'))
        (work / 'codex-task.json').write_text(json.dumps(manifest))
        return work

    def independent_receipt(self, event='independent'):
        return dict(eventId=event, taskId='T022', sessionId='worker-one', turnId='turn-independent',
            kind='delivery', occurredAt=self.iso(), checklist=[], limitations=[],
            summary='Independent existing receipt', source='worker-one')

    def test_submit_is_sql_only_fast_and_no_brief_launcher_or_model(self):
        with patch.object(dispatch, 'render_brief', side_effect=AssertionError('brief on submit')), \
             patch.object(dispatch.subprocess, 'Popen', side_effect=AssertionError('launch on submit')):
            start = time.perf_counter()
            op = self.submit()
            elapsed = time.perf_counter() - start
        self.assertLess(elapsed, 1)
        self.assertEqual(op['status'], 'queued')
        self.assertFalse(Path(op['payload']['workdir']).exists())
        self.assertEqual(op['payload']['contract']['goal'], 'Registered goal')
        self.assertEqual(op['payload']['worker'], dict(threadId='worker-one', sessionId='worker-one'))

    def test_concurrent_duplicate_and_changed_payload_collision(self):
        data = self.payload()
        def submit(_):
            ledger = Ledger(self.tmp.name, test_mode=True)
            ledger._receipt_now = self.iso
            return ledger.dispatch_submit(data)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(submit, range(16)))
        self.assertEqual(sum(not op['reused'] for op in results), 1)
        changed = dict(data, goal='Different goal')
        with self.assertRaises(TransitionError):
            self.ledger.dispatch_submit(changed)
        self.now += timedelta(hours=3)
        self.assertTrue(self.ledger.dispatch_submit(data)['reused'])
        self.assertEqual(self.launches, [])

    def test_simultaneous_payload_collision_has_one_winner(self):
        def submit(number):
            ledger = Ledger(self.tmp.name, test_mode=True)
            ledger._receipt_now = self.iso
            data = dict(self.payload(), goal='variant-' + str(number % 2))
            try:
                return ledger.dispatch_submit(data)
            except TransitionError:
                return 'collision'
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(submit, range(16)))
        saved = self.ledger.dispatch_list()
        self.assertEqual(len(saved), 1)
        self.assertEqual(sum(isinstance(item, dict) and not item['reused'] for item in results), 1)
        self.assertEqual(results.count('collision'), 8)

    def test_input_deadline_path_and_queue_bounds(self):
        for request in ('../escape', 'a/b', '.hidden', 'a.b', 'a' * 65, 'bad\nname'):
            with self.subTest(request=request), self.assertRaises(ValidationError):
                self.ledger.dispatch_submit(dict(self.payload(), requestId=request))
        for deadline in ('2026-11-03T15:00:00', '2026-11-03T23:00:00+08:00',
                         '2026-11-03T13:59:59Z', '2026-11-03T16:00:01Z'):
            with self.subTest(deadline=deadline), self.assertRaises(ValidationError):
                self.ledger.dispatch_submit(dict(self.payload(), deadline=deadline))
        with patch.object(dispatch, 'MAX_OUTSTANDING', 2):
            self.submit('one')
            self.submit('two')
            with self.assertRaises(TransitionError):
                self.submit('three')
        with self.assertRaises(ValidationError):
            self.ledger.dispatch_list(101)
        with self.assertRaises(ValidationError):
            self.ledger.dispatch_claim(3)

    def test_registered_active_worker_required_no_native_create_bind(self):
        self.ledger.register(dict(id='T023', title='Unbound'))
        with self.assertRaises(TransitionError):
            self.ledger.dispatch_submit(dict(self.payload(), taskId='T023'))
        self.ledger.register(dict(id='T024', title='Controller', threadId=CONTROLLER_THREAD_ID,
                                  execution='running'))
        with self.assertRaises(TransitionError):
            self.ledger.dispatch_submit(dict(self.payload(), taskId='T024'))

    def test_active_role_session_origin_and_contract_are_captured(self):
        self.ledger.register(dict(id='T025', title='Role project', goal='Original role goal'))
        self.ledger.add_task_session('T025', dict(sessionId='role-session', threadId='role-worker',
            role='executor', responsibilityStatus='active'), 'add-role')
        self.ledger.apply_session_observation('T025', 'role-session',
            dict(live=True, turnStatus='inProgress', turnId='role-turn', revision='one'), self.iso())
        op = self.ledger.dispatch_submit(dict(self.payload('role-request'), taskId='T025'))
        self.ledger.update_contract('T025', dict(goal='Later contract edit'))
        self.runner.tick()
        saved = self.ledger.dispatch_status(op['opId'])
        self.assertEqual(saved['payload']['contract']['goal'], 'Original role goal')
        self.assertEqual(saved['payload']['worker'], dict(threadId='role-worker', sessionId='role-session'))
        self.write_state(saved)
        self.child.code = 0
        self.runner.tick()
        self.ledger.drain_receipts(receiver=LedgerReceiver(self.ledger))
        receipt = self.ledger.get_receipt(op['opId'])
        self.assertEqual((receipt['sessionId'], receipt['source']), ('role-session', 'role-worker'))

    def test_explicit_increment_can_submit_with_stale_worker_observation(self):
        self.ledger.apply_observation('T022', dict(live=False, turnStatus='completed',
            turnId='previous-turn', revision='previous'), self.iso())
        op = self.submit()
        self.assertEqual(op['status'], 'queued')
        self.assertEqual(op['payload']['worker']['sessionId'], 'worker-one')

    def test_concurrent_claims_global_two_and_tick_claims_only_one(self):
        self.ledger.register(dict(id='T023', title='Another project', threadId='worker-two', execution='running'))
        for number in range(8):
            self.ledger.dispatch_submit(dict(self.payload('request-' + str(number)),
                                             taskId='T023' if number % 2 else 'T022'))
        def claim(_):
            ledger = Ledger(self.tmp.name, test_mode=True)
            ledger._receipt_now = self.iso
            return ledger.dispatch_claim(limit=2)
        with ThreadPoolExecutor(max_workers=5) as pool:
            claims = [op for result in pool.map(claim, range(5)) for op in result]
        self.assertEqual(len(claims), 2)
        self.assertEqual(len({op['opId'] for op in claims}), 2)
        self.assertEqual(self.runner.tick()['claimed'], 0)
        self.assertEqual(self.launches, [])

    def test_deadline_failure_holds_two_uncertain_slots_until_process_exit_evidence(self):
        first = self.ledger.dispatch_submit(dict(self.payload('early-one'),
            deadline=(self.now + timedelta(seconds=10)).isoformat()))
        second = self.ledger.dispatch_submit(dict(self.payload('early-two'),
            deadline=(self.now + timedelta(seconds=10)).isoformat()))
        later = self.submit('later')
        self.runner.tick()
        self.runner.tick()
        self.assertEqual(len(self.launches), 2)
        self.now += timedelta(seconds=11)
        self.runner.tick()
        for op in (first, second):
            saved = self.ledger.dispatch_status(op['opId'])
            self.assertEqual(saved['status'], 'failed')
            self.assertTrue(saved['payload']['capacityHeld'])
        self.assertEqual(self.ledger.dispatch_status(later['opId'])['status'], 'queued')
        for op in (first, second):
            self.write_state(self.ledger.dispatch_status(op['opId']))
        self.child.code = 0
        self.runner.tick()
        self.assertEqual(len(self.launches), 3)
        self.assertEqual(self.ledger.dispatch_status(later['opId'])['payload']['launchAttempts'], 1)

    def test_tick_claim_bound_pinned_argv_deadline_and_inherited_brief(self):
        self.submit('other')
        op = self.start()
        self.assertEqual(len(self.launches), 1)
        argv, options = self.launches[0]
        self.assertEqual(argv[:-3], dispatch.PINNED)
        self.assertEqual(argv[-1], '1')
        self.assertNotIn('shell', options)
        self.assertLessEqual(int(options['env']['DELEGATE_MAX_SECONDS']), 3600)
        work = Path(options['cwd'])
        brief = (work / 'BRIEF.md').read_text()
        for value in ('Increment goal', 'check candidate', 'WORKDIR only', 'Fake tests only',
                      'Registered goal', 'existing authority', 'Preserve all other changes'):
            self.assertIn(value, brief)
        deadline = json.loads((work / 'DELEGATE_DEADLINE.json').read_text())
        self.assertEqual(deadline['deadline_at'], self.payload()['deadline'])
        self.assertEqual(deadline['deadline_epoch'], self.now.timestamp() + 3600)

    def test_restart_unknown_launch_and_claimed_intent_never_respawn(self):
        op = self.start()
        reopened = Ledger(self.tmp.name, test_mode=True)
        reopened._receipt_now = self.iso
        runner = dispatch.DispatchRunner(reopened, popen=lambda *a, **k: self.fail('respawn'))
        self.now += timedelta(seconds=6)
        runner.tick()
        saved = reopened.dispatch_status(op['opId'])
        self.assertEqual(saved['status'], 'reconciliation-needed')
        self.assertEqual(saved['payload']['launchAttempts'], 1)
        self.assertIsNone(saved['payload']['timings']['launcherReturnedAt'])
        self.now += timedelta(hours=1)
        runner.tick()
        saved = reopened.dispatch_status(op['opId'])
        self.assertEqual(saved['status'], 'failed')
        self.assertEqual(saved['payload']['terminalCode'], 'missed-deadline')
        self.assertTrue(saved['payload']['capacityHeld'])
        self.assertEqual(len(self.launches), 1)

    def test_crash_after_claim_before_launch_never_respawn(self):
        op = self.submit()
        self.ledger.dispatch_claim()
        self.now += timedelta(seconds=6)
        self.runner.tick()
        self.assertEqual(self.ledger.dispatch_status(op['opId'])['status'], 'reconciliation-needed')
        self.assertEqual(self.launches, [])
        self.now += timedelta(hours=1)
        self.runner.tick()
        self.assertEqual(self.ledger.dispatch_status(op['opId'])['payload']['launchAttempts'], 0)

    def test_queued_missed_deadline_is_terminal_without_launch(self):
        op = self.submit()
        self.now += timedelta(hours=1, seconds=1)
        self.runner.tick()
        self.runner.tick()
        saved = self.ledger.dispatch_status(op['opId'])
        self.assertEqual(saved['status'], 'failed')
        self.assertEqual(saved['payload']['terminalCode'], 'missed-deadline')
        self.assertEqual(self.launches, [])
        self.assertEqual(self.ledger.delivery_status(op['opId'])['status'], 'pending')

    def test_subsecond_launch_budget_fails_without_claiming_deadline_already_passed(self):
        op = self.ledger.dispatch_submit(dict(self.payload(),
            deadline=(self.now + timedelta(microseconds=500000)).isoformat()))
        self.runner.tick()
        saved = self.ledger.dispatch_status(op['opId'])
        self.assertEqual(saved['status'], 'failed')
        self.assertEqual(saved['payload']['terminalCode'], 'insufficient-deadline-budget')
        self.assertEqual(self.launches, [])

    def test_launcher_timeout_is_nonblocking_and_retains_capacity(self):
        op = self.start()
        self.now += timedelta(seconds=6)
        self.runner.tick()
        saved = self.ledger.dispatch_status(op['opId'])
        self.assertEqual(saved['status'], 'reconciliation-needed')
        self.assertEqual(saved['payload']['reconciliationCode'], 'launcher-timeout')
        self.runner.tick()
        self.assertEqual(len(self.launches), 1)

    def test_independent_receipts_drain_while_launcher_pending_and_tick_fails(self):
        self.submit()
        self.ledger.enqueue_receipt(self.independent_receipt())
        collector = ReceiptRecoveryCollector(self.ledger, workers=1)
        self.addCleanup(collector.close)
        collector._dispatch_runner = self.runner
        with patch('orchestra.receipt_delivery.NativeWakeAdapter.send', side_effect=AssertionError('native send')):
            start = time.perf_counter()
            result = collector._executor.submit(collector._recover_receipts).result(timeout=2)
            self.assertLess(time.perf_counter() - start, 1)
            self.assertEqual(result[0]['status'], 'sent')
            self.assertEqual(len(self.launches), 1)
            self.ledger.enqueue_receipt(self.independent_receipt('second'))
            with patch.object(self.runner, 'tick', side_effect=RuntimeError('isolated dispatch failure')):
                result = collector._recover_receipts()
            self.assertEqual(result[0]['status'], 'sent')
        self.assertIsNotNone(self.ledger.get_receipt('independent'))

    def test_done_alone_and_live_pid_never_success(self):
        op = self.start()
        work = Path(op['payload']['workdir'])
        (work / 'DONE').write_text('premature')
        self.runner.tick()
        self.assertNotIn(self.ledger.dispatch_status(op['opId'])['status'], dispatch.TERMINAL)
        self.write_state(op, pid=os.getpid())
        self.child.code = 0
        self.runner.tick()
        self.assertNotIn(self.ledger.dispatch_status(op['opId'])['status'], dispatch.TERMINAL)
        self.assertIsNone(self.ledger.get_receipt(op['opId']))

    def test_real_runner_exit_field_fixture_and_first_session_event_unknown_time(self):
        op = self.start()
        fixture = json.loads((EVIDENCE / 'codex-terminal-state.json').read_text())
        fixture.update(pid=DEAD_PID, deadline_at=op['payload']['package']['deadline'])
        work = self.write_state(op, **fixture)
        (work / 'codex-events-1.jsonl').write_text('{"type":"thread.started","thread_id":"fake"}\n')
        self.child.code = 0
        self.runner.tick()
        saved = self.ledger.dispatch_status(op['opId'])
        self.assertEqual(saved['status'], 'completed')
        self.assertTrue(saved['payload']['manifestVerified'])
        self.assertEqual(saved['payload']['firstEventType'], 'thread.started')
        self.assertIsNone(saved['payload']['timings']['firstEventAt'])
        self.assertEqual(saved['payload']['timings']['firstEventObservedAt'], self.iso())
        self.assertEqual(saved['payload']['receipt']['checklist'][0]['status'], 'unverified')

    def test_restart_monitors_known_workdir_and_never_uses_launcher(self):
        op = self.start()
        work = self.write_state(op)
        self.child.code = 0
        self.runner._children[op['opId']].poll()
        runner = dispatch.DispatchRunner(self.ledger, popen=lambda *a, **k: self.fail('respawn'))
        runner.tick()
        saved = self.ledger.dispatch_status(op['opId'])
        self.assertEqual(saved['status'], 'completed')
        self.assertIsNone(saved['payload']['timings']['launcherReturnedAt'])
        self.assertEqual(saved['payload']['launchAttempts'], 1)
        self.assertEqual(len(self.launches), 1)

    def test_missing_exit_is_unknown_and_invalid_deadline_fails(self):
        op = self.start()
        work = self.write_state(op)
        state = json.loads((work / 'codex-state.json').read_text())
        state.pop('exit')
        (work / 'codex-state.json').write_text(json.dumps(state))
        self.child.code = 0
        self.runner.tick()
        self.assertEqual(self.ledger.dispatch_status(op['opId'])['status'], 'reconciliation-needed')
        deadline = json.loads((work / 'DELEGATE_DEADLINE.json').read_text())
        deadline['deadline_at'] = 'corrupt'
        (work / 'DELEGATE_DEADLINE.json').write_text(json.dumps(deadline))
        self.runner.tick()
        self.assertEqual(self.ledger.dispatch_status(op['opId'])['status'], 'failed')

    def test_stale_running_state_with_dead_process_is_reconciliation_needed(self):
        op = self.start()
        self.write_state(op, running=True, done=False)
        self.child.code = 0
        self.runner.tick()
        saved = self.ledger.dispatch_status(op['opId'])
        self.assertEqual(saved['status'], 'reconciliation-needed')
        self.assertEqual(saved['payload']['reconciliationCode'], 'runner-process-unconfirmed')

    def test_failed_or_nonzero_exit_wins_over_done(self):
        for changes in (dict(failed=True, done=True, exit=1), dict(failed=False, done=True, exit=2)):
            with self.subTest(changes=changes):
                op = self.start('failure-' + str(changes['exit']))
                self.write_state(op, **changes)
                self.child.code = 0
                self.runner.tick()
                self.assertEqual(self.ledger.dispatch_status(op['opId'])['status'], 'failed')

    def test_manifest_route_mismatch_is_failure_no_fallback(self):
        op = self.start()
        work = self.write_state(op)
        manifest = json.loads((work / 'codex-task.json').read_text())
        manifest['provider'] = 'wrong-provider'
        (work / 'codex-task.json').write_text(json.dumps(manifest))
        self.child.code = 0
        self.runner.tick()
        saved = self.ledger.dispatch_status(op['opId'])
        self.assertEqual(saved['payload']['terminalCode'], 'manifest-mismatch')
        self.assertFalse(saved['payload']['manifestVerified'])
        self.assertEqual(len(self.launches), 1)

    def test_absolute_runner_deadline_never_extended_or_rewritten(self):
        op = self.start()
        work = self.write_state(op, running=True, done=False)
        deadline_path = work / 'DELEGATE_DEADLINE.json'
        deadline = json.loads(deadline_path.read_text())
        deadline['deadline_epoch'] += 10
        deadline_path.write_text(json.dumps(deadline))
        before = deadline_path.read_bytes()
        self.runner.tick()
        saved = self.ledger.dispatch_status(op['opId'])
        self.assertEqual(saved['payload']['terminalCode'], 'runner-deadline-exceeded')
        self.assertEqual(before, deadline_path.read_bytes())

    def test_deterministic_receipt_survives_enqueue_crash_retry_and_silent_ack(self):
        op = self.start()
        self.write_state(op)
        self.child.code = 0
        with patch.object(self.ledger, 'enqueue_receipt', side_effect=RuntimeError('before enqueue')):
            self.runner.tick()
        frozen = self.ledger.dispatch_status(op['opId'])['payload']['receipt']
        self.now += timedelta(seconds=30)
        original = self.ledger.enqueue_receipt
        def committed_then_crash(payload):
            original(payload)
            raise RuntimeError('after enqueue commit')
        with patch.object(self.ledger, 'enqueue_receipt', side_effect=committed_then_crash):
            self.runner.tick()
        self.now += timedelta(seconds=30)
        self.runner.tick()
        self.assertEqual(frozen, self.ledger.dispatch_status(op['opId'])['payload']['receipt'])
        for policy in (None, '0'):
            if policy is not None:
                self.ledger.set_meta('receipt_native_wake_enabled', policy)
            collector = ReceiptRecoveryCollector(self.ledger)
            with patch('orchestra.receipt_delivery.NativeWakeAdapter.send', side_effect=AssertionError('wake')), \
                 patch('orchestra.bridge.post_command', side_effect=AssertionError('native I/O')):
                collector._recover_receipts()
            collector.close()
        received = self.ledger.get_receipt(op['opId'])
        self.assertEqual(received['occurredAt'], frozen['occurredAt'])
        self.assertEqual(received['source'], 'worker-one')
        self.assertEqual(received['sessionId'], 'worker-one')
        self.assertEqual(received['turnId'], 'dispatch:request-one')
        self.assertEqual(received['reviews'], [])
        self.assertEqual(self.ledger.delivery_status(op['opId'], queue='wake')['attempts'], 0)
        saved = self.ledger.dispatch_status(op['opId'])
        for name in ('submittedAt', 'claimedAt', 'launchStartedAt', 'launcherReturnedAt',
                     'terminalAt', 'enqueuedAt', 'receivedAt'):
            self.assertIsNotNone(saved['payload']['timings'][name], name)
        self.runner.tick()
        with self.ledger._receipt_tx(False) as connection:
            raw = json.loads(connection.execute('SELECT payload FROM operations WHERE op_id=?',
                                                (op['opId'],)).fetchone()['payload'])
        self.assertEqual(raw['timings']['receivedAt'], received['receivedAt'])

    def test_cli_submit_status_list_never_launches(self):
        data = self.payload()
        data['deadline'] = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
        path = Path(self.tmp.name) / 'package.json'
        path.write_text(json.dumps(data))
        with patch.object(dispatch.subprocess, 'Popen', side_effect=AssertionError('CLI launch')):
            for argv in (['dispatch-submit', '--json', str(path)],
                         ['dispatch-status', 'silent_dispatch:request-one'], ['dispatch-list', '--limit', '1']):
                with patch('sys.stdout', new_callable=io.StringIO) as stdout:
                    code = main(['--state', self.tmp.name, '--test', *argv])
                self.assertEqual(code, 0)
                response = json.loads(stdout.getvalue())
                self.assertTrue(response)
                if argv[0] == 'dispatch-submit':
                    self.assertEqual(set(response), {'opId', 'taskId', 'status', 'reused'})
                    self.assertLess(len(stdout.getvalue()), 250)

    def test_internal_dispatch_stays_out_of_general_snapshot(self):
        op = self.submit()
        self.assertNotIn(op['opId'], [item['opId'] for item in self.ledger.snapshot()['operations']])
        self.assertEqual(self.ledger.dispatch_status(op['opId'])['status'], 'queued')

    def test_missing_launcher_fails_once_and_preserves_receipt_processing(self):
        op = self.submit()
        runner = dispatch.DispatchRunner(self.ledger, popen=lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError()))
        runner.tick()
        runner.tick()
        saved = self.ledger.dispatch_status(op['opId'])
        self.assertEqual(saved['status'], 'failed')
        self.assertEqual(saved['payload']['terminalCode'], 'launcher-not-started')
        self.assertEqual(saved['payload']['launchAttempts'], 1)

    def test_service_path_and_launcher_diagnostics_are_preserved(self):
        op = self.submit()
        def launch(argv, **kwargs):
            self.assertIn('/opt/homebrew/bin', kwargs['env']['PATH'].split(os.pathsep))
            self.assertIn('/Users/zhuhe/.local/bin', kwargs['env']['PATH'].split(os.pathsep))
            kwargs['stdout'].write(b'controlled launcher diagnostic\n')
            return self.child
        runner = dispatch.DispatchRunner(self.ledger, popen=launch)
        with patch.dict(os.environ, {'PATH': '/usr/bin:/bin'}):
            runner.tick()
        work = Path(op['payload']['workdir'])
        self.assertEqual((work / 'launcher.log').read_text(), 'controlled launcher diagnostic\n')


if __name__ == '__main__':
    unittest.main()

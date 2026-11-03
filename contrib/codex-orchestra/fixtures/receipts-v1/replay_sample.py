"""Deterministic isolated replay producing sample.json; no live bridge or socket.

Times below are a labelled simulated clock, not production history or native
cross-chat evidence. Every output is computed through the shipped Ledger API.
"""

import json
import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2]))
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from orchestra.constants import CONTROLLER_THREAD_ID as CONTROLLER
from orchestra.ledger import Ledger
from orchestra.receipt_delivery import LedgerReceiver, NativeWakeAdapter

ROOT = Path(__file__).resolve().parent
BASE = datetime(2026, 11, 2, tzinfo=timezone.utc)


class SimulatedNative(NativeWakeAdapter):
    is_test = True

    def __init__(self):
        self.calls = []
        self.delivered = set()
        super().__init__(post=self.fake_post)

    def fake_post(self, command):
        # Persist only op/identity/count metadata in the sample, never text.
        self.calls.append(dict(op=command['op'], target=command['id'], actionIdPresent=bool(command.get('actionId'))))
        if command['op'] == 'send':
            self.delivered.add(command['text'].split('[orchestra-receipt:', 1)[1].split('] ', 1)[0])
            return 502, dict(ok=False, delivery='unknown')
        return 200, dict(ok=True, result=dict(id=CONTROLLER, turns=[
            dict(id='simulated-native-turn-' + event, items=[dict(role='user',
                text=self.marker(event) + ' Durable receipt is ready.')]) for event in sorted(self.delivered)]))


def replay():
    clock = [BASE]
    def iso():
        return clock[0].isoformat(timespec='microseconds')
    operations = []
    snapshots = []
    public_snapshots = []
    with tempfile.TemporaryDirectory(prefix='sample-ledger-', dir=str(ROOT)) as directory:
        with patch('orchestra.receipts.now_iso', side_effect=iso):
            ledger = Ledger(directory, test_mode=True)
        ledger._receipt_now = iso
        wake = SimulatedNative()
        ledger.wake_adapter = wake
        # This labelled fixture explicitly covers the opt-in wake protocol.
        ledger.set_meta('receipt_native_wake_enabled', '1')
        ledger.register(dict(id='T022', title='Isolated replay only', threadId='sample-worker'))

        def run(second, method, data, **kwargs):
            clock[0] = BASE + timedelta(seconds=second)
            if method == 'update_decision':
                data = dict(data, expectedRevision=ledger.get_decision(kwargs['decision_id'])['revision'])
                result = ledger.update_decision(kwargs['decision_id'], data, actor_id=CONTROLLER)
            elif method == 'review_receipt':
                result = ledger.review_receipt(kwargs['event_id'], data, actor_id=CONTROLLER)
            elif method == 'create_decision':
                result = ledger.create_decision(data, actor_id=CONTROLLER)
            elif method == 'dispatch_receipt':
                result = ledger.dispatch_receipt(kwargs['event_id'], LedgerReceiver(ledger))
            elif method == 'dispatch_wake':
                result = ledger.dispatch_wake(kwargs['event_id'], wake)
            else:
                result = getattr(ledger, method)(data)
            operations.append(dict(at=iso(), method=method, arguments=dict(data=data, **kwargs), result=result))
            return result

        def receipt(event, second, turn=None):
            return dict(eventId=event, taskId='T022', sessionId='sample-worker', turnId=turn or ('turn-' + event),
                        kind='delivery', occurredAt=(BASE + timedelta(seconds=second)).isoformat(),
                        checklist=[dict(requirement='Evidence checked', status='pass', evidence=['file:sample-evidence'])],
                        limitations=['Simulated replay; not production or native acceptance proof'],
                        summary='Safe simulated delivery', source='sample-worker-source')

        def create(second, suffix, authority='controller', due=None, use_outbox=False):
            event = 'receipt-' + suffix
            payload = receipt(event, second)
            if use_outbox:
                run(second, 'enqueue_receipt', payload)
                run(second, 'dispatch_receipt', None, event_id=event)
                snapshot(second + 3, 'unreviewed-receipt-before-decision')
            else:
                run(second, 'receive_receipt', payload)
            recorded_second = second + 5 if use_outbox else second
            run(recorded_second, 'review_receipt', dict(reviewId='review-' + suffix, result='accepted',
                                             evidence=['file:independent-review-' + suffix]), event_id=event)
            decision = dict(decisionId='decision-' + suffix, receiptId=event, taskId='T022', stageId='stage-' + suffix,
                            sessionId='sample-worker', turnId='turn-' + event, decisionRequired=True,
                            authority=authority, trigger='Explicit review decision', options=['accept', 'rework'],
                            owner='sample-worker', publicDisplay=dict(question='Review the delivery', nextAction=None, owner='Worker'), dueAt=(BASE + timedelta(seconds=due)).isoformat() if due is not None else None)
            run(recorded_second, 'create_decision', decision)
            return payload

        def update(second, suffix, action, **data):
            return run(second, 'update_decision', dict(action=action, **data), decision_id='decision-' + suffix)

        def choose(second, suffix):
            return update(second, suffix, 'choose', choice='accept', reason='Independent review supports this option',
                          nextAction='Execute and report evidence', decidedBy=CONTROLLER,
                          publicDisplay=dict(question='Review the delivery', nextAction='Execute and report', owner='Worker'))

        def snapshot(second, label, include_test=True):
            clock[0] = BASE + timedelta(seconds=second)
            snapshots.append(dict(label=label, snapshot=ledger.decisions_snapshot(include_test=include_test)))
            public_snapshots.append(dict(label=label, snapshot=ledger.public_decisions_snapshot(include_test=include_test)))

        initial = create(0, 'complete', use_outbox=True)
        run(6, 'receive_receipt', initial)  # duplicate: one notice/wake/decision
        choose(10, 'complete')
        update(11, 'complete', 'action')
        run(20, 'receive_receipt', receipt('execution-complete', 20, 'execution-turn'))
        update(20, 'complete', 'execution-confirm', executionReceiptId='execution-complete', evidence=['file:execution-confirmation'])
        snapshot(20, 'awaiting-independent-verification')
        update(21, 'complete', 'verify', evidence=['file:independent-execution-check'])
        snapshot(21, 'verified')
        create(30, 'user', authority='user', due=60)
        create(40, 'external', authority='external')
        create(50, 'action', due=100)
        choose(70, 'action')
        update(71, 'action', 'action')
        create(80, 'rework')
        choose(110, 'rework')
        update(111, 'rework', 'action')
        update(120, 'rework', 'rework', reason='Independent check requests correction', evidence=['file:rework-evidence'])
        snapshot(125, 'rework-stays-same-decision')
        choose(130, 'rework')
        update(131, 'rework', 'revise', nextAction='Revised execution instruction')
        create(140, 'revoked')
        choose(145, 'revoked')
        update(146, 'revoked', 'revoke', reason='Independent cancellation', evidence=['file:cancel-evidence'])
        # Passive receive only ACKs the durable transaction. Simulate the
        # existing collector explicitly draining pending wakes, then reconciling
        # unknown first sends by readback without a second send.
        events = sorted({operation['arguments']['data']['eventId'] for operation in operations
                         if operation['method'] in ('receive_receipt', 'enqueue_receipt')})
        for event in events:
            run(149, 'dispatch_wake', None, event_id=event)
        # All first sends are deliberately unknown. Only reads reconcile them.
        for event in sorted(wake.delivered):
            run(150, 'dispatch_wake', None, event_id=event)
        snapshot(160, 'test-visible-final')
        snapshot(160, 'default-production-view-excludes-test', include_test=False)
        assert len(wake.delivered) == 7
        assert sum(call['op'] == 'send' for call in wake.calls) == 7
        assert sum(call['op'] == 'read' for call in wake.calls) == 7
        final = snapshots[-2]['snapshot']
        assert final['counts']['decided'] == 4 and final['counts']['currentlyEffective'] == 3
        assert final['counts']['overdue'] is None and final['counts']['knownOverdue'] == 2
        assert final['latency']['sampleCount'] == 4 and final['latency']['p50'] == 10.0 and final['latency']['p95'] == 30.0
        assert snapshots[-1]['snapshot']['decisions'] == []
        return dict(interfaceVersion=1, sampleType='isolated-simulated-clock-replay',
                    realNativeSendPerformed=False, realCrossChatProof=False, parentAcceptance=False,
                    replayCommand='PYTHONPATH=output python3 output/replay_sample.py',
                    operations=operations, snapshots=snapshots, publicSnapshots=public_snapshots,
                    hostSnapshotKeys=sorted(ledger.snapshot()), hostSnapshot=dict(
                        systemDecisions=ledger.public_decisions_snapshot(), receiptReviewBacklog=ledger.receipt_review_backlog()),
                    transportMetadata=wake.calls,
                    histories={suffix: ledger.get_decision('decision-' + suffix, history=True)['history']
                               for suffix in ('complete', 'rework', 'revoked')},
                    summary=dict(distinctDecisions=len(final['decisions']), decisionLatencySamples=sorted(
                                     (datetime.fromisoformat(r['firstDecidedAt']) - datetime.fromisoformat(r['triggeredAt'])).total_seconds()
                                     for r in final['decisions'] if r['firstDecidedAt'] is not None),
                                 finalCounts=final['counts'], finalLatency=final['latency'],
                                 wakeSendCount=sum(call['op'] == 'send' for call in wake.calls),
                                 wakeReadCount=sum(call['op'] == 'read' for call in wake.calls)))


if __name__ == '__main__':
    sample = replay()
    (ROOT / 'sample.json').write_text(json.dumps(sample, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(sample['summary'], ensure_ascii=False, sort_keys=True))

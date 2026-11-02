"""Real isolated SQLite + adapter protocol; latency is explicitly simulated.
No native send, native agent invocation, review acceptance or decision mutation.
Run from workdir with uv run --offline --no-project python ...
"""
import argparse
import hashlib
import json
import platform
from pathlib import Path
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

parser = argparse.ArgumentParser()
parser.add_argument('--source', choices=('input', 'output'), required=True)
parser.add_argument('--mode', choices=('baseline', 'optimized'), required=True)
parser.add_argument('--repeat', type=int, default=3)
parser.add_argument('--result', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / args.source))
from orchestra.ledger import Ledger
from orchestra.receipt_delivery import NativeWakeAdapter
from orchestra.constants import CONTROLLER_THREAD_ID as PARENT
config_path = Path(__file__).with_name('workload.json')
config = json.loads(config_path.read_text())

def receipt(event):
    return dict(eventId=event, taskId='T022', sessionId='bench-worker', turnId='turn-' + event,
                kind='delivery', occurredAt='2026-11-02T17:00:00Z', checklist=[dict(
                    requirement='return candidate evidence', status='unverified', evidence=[])],
                limitations=['Synthetic review and native transport latency; no native agent invoked'],
                summary='Frozen mixed workload', source='bench-worker')

runs = []
for repeat in range(args.repeat):
    with tempfile.TemporaryDirectory(prefix='bench-', dir=root / 'output/benchmarks') as state:
        ledger = Ledger(state, test_mode=True)
        ledger.register(dict(id='T022', title='Isolated benchmark', threadId='bench-worker'))
        rows = {j['eventId']: dict(eventId=j['eventId'], reviewSeconds=j['reviewSeconds']) for j in config['jobs']}
        wire = {}; lock = threading.Lock(); active = [0]; max_active = [0]
        scheduler_samples = []
        start = time.monotonic_ns()
        def stamp(): return (time.monotonic_ns() - start) / 1e9
        receiving = threading.local()
        original_tx = ledger._receipt_tx
        @contextmanager
        def timed_tx(write=True):
            with original_tx(write) as connection:
                yield connection
            event = getattr(receiving, 'event', None)
            if write and event and 'durableCommittedAt' not in rows[event]:
                # First completed write transaction of receive: commit + close
                # has returned, before the independent wake claim transaction.
                rows[event]['durableCommittedAt'] = stamp()
        ledger._receipt_tx = timed_tx
        def post(command):
            if command['op'] == 'send':
                event = command['text'].split('[orchestra-receipt:', 1)[1].split(']', 1)[0]
                rows[event]['wakeStart'] = stamp()
                time.sleep(config['wakeSeconds'])
                wire[event] = command['text']
                return 200, dict(ok=True)
            turns = [dict(id='simulated-turn-' + event, items=[dict(role='user', text=text)])
                     for event, text in wire.items()]
            return 200, dict(ok=True, result=dict(id=PARENT, turns=turns))
        class TestAdapter(NativeWakeAdapter):
            is_test = True
            def reconcile(self, event):
                outcome = super().reconcile(event)
                rows[event]['wakeMarkerReadAt'] = stamp()
                return outcome
        adapter = TestAdapter(post=post)
        def receive(job):
            event = job['eventId']; row = rows[event]; row['receiveStart'] = stamp()
            receiving.event = event
            if args.mode == 'baseline':
                # Input version's API is explicitly synchronous.
                ack = ledger.receive_receipt(receipt(event), wake_adapter=adapter)
            else:
                ack = ledger.receive_receipt(receipt(event), wake_mode='durable')
            row['ackAt'] = stamp(); row['ack'] = ack['ack']
            receiving.event = None
        def verify(job, claim=None):
            event = job['eventId']; row = rows[event]
            row['firstHandling'] = stamp()
            if claim is not None:
                claim = ledger.verification('start', dict(eventId=event, token=claim['token'],
                    revision=claim['revision'], dispatchId='simulated-dispatch-' + event,
                    executionId='simulated-agent-' + event), actor_id=PARENT)
            row['candidateStart'] = stamp()
            with lock:
                active[0] += 1; max_active[0] = max(max_active[0], active[0])
                row['activeAtStart'] = active[0]
            time.sleep(job['reviewSeconds'])
            if claim is not None:
                ledger.verification('submit', dict(eventId=event, token=claim['token'],
                    revision=claim['revision'], evidence=['file:synthetic-' + event],
                    summary='Synthetic candidate only', limitations=['No native agent invoked']), actor_id=PARENT)
            row['candidateFinish'] = stamp()
            with lock: active[0] -= 1
        errors = []
        if args.mode == 'baseline':
            for job in config['jobs']:
                receive(job); verify(job)
        else:
            # Parent simulator and wake recovery share a fixed four-worker executor.
            # Production native tools remain exclusively under the real parent.
            with ThreadPoolExecutor(max_workers=4) as executor:
                for job in config['jobs']: receive(job)
                wake_future = executor.submit(ledger.drain_receipts, wake_adapter=adapter, limit=100)
                futures = []; jobs = {j['eventId']: j for j in config['jobs']}
                while jobs or futures:
                    remaining = []
                    for future in futures:
                        if future.done():
                            try: future.result()
                            except Exception as exc: errors.append(type(exc).__name__ + ': ' + str(exc))
                        else: remaining.append(future)
                    futures = remaining
                    while jobs:
                        claim = ledger.verification('claim', dict(owner='benchmark-parent'), actor_id=PARENT)
                        if claim is None: break
                        rows[claim['eventId']]['firstClaim'] = stamp()
                        snapshot = ledger.verification_snapshot(include_test=True)
                        scheduler_samples.append(dict(at=stamp(), inflight=snapshot['inflight'],
                                                      states=snapshot['states']))
                        job = jobs.pop(claim['eventId'])
                        futures.append(executor.submit(verify, job, claim))
                    if futures: time.sleep(0.001)
                    elif jobs: raise RuntimeError('queue stalled')
                wake_results = wake_future.result()
                for result in wake_results:
                    rows[result['eventId']]['wakeStatus'] = result['status']
        workload_finished_at = stamp()
        for event, row in rows.items():
            with ledger._receipt_tx(False) as conn:
                attempt = conn.execute("SELECT started_at,finished_at FROM receipt_attempts WHERE queue='wake' AND event_id=?", (event,)).fetchone()
            row['wakePersistedAttempt'] = dict(attempt) if attempt else None
            row['wakeMarkerVerified'] = ledger.delivery_status(event, queue='wake')['status'] == 'sent'
            row['durableReceiveSeconds'] = row['durableCommittedAt'] - row['receiveStart']
            row['nativeWakeSimulatedSeconds'] = row['wakeMarkerReadAt'] - row['wakeStart']
            row['receiveToAck'] = row['ackAt'] - row['receiveStart']
            row['receiveToFirstClaim'] = row['firstClaim'] - row['receiveStart'] if 'firstClaim' in row else None
            row['durableReceiveToFirstClaim'] = row['firstClaim'] - row['durableCommittedAt'] if 'firstClaim' in row else None
            row['arrivalToFirstHandling'] = row['firstHandling']
            row['receiveToFirstHandling'] = row['firstHandling'] - row['receiveStart']
            row['durableReceiveToFirstHandling'] = row['firstHandling'] - row['durableCommittedAt']
            row['candidateDuration'] = row['candidateFinish'] - row['candidateStart']
            row['durableReceiveToCandidateFinish'] = row['candidateFinish'] - row['durableCommittedAt']
            if args.mode == 'optimized':
                job = ledger.verification_package(event)['job']
                row['persistedCandidateState'] = job['state']
                row['validCompletion'] = ('candidateFinish' in row and job['state'] == 'submitted'
                                          and job['execution']['state'] == 'completed')
            else:
                row['persistedCandidateState'] = None
                row['validCompletion'] = 'candidateFinish' in row  # Serial synthetic verification only.
        with ledger._receipt_tx(False) as conn:
            reviews = conn.execute('SELECT COUNT(*) FROM receipt_reviews').fetchone()[0]
            decisions = conn.execute('SELECT COUNT(*) FROM decisions').fetchone()[0]
        runs.append(dict(repeat=repeat + 1, duration=workload_finished_at,
                         measurementAndValidationDuration=stamp(), maxInflightObserved=max_active[0],
                         maxGlobalReservationsObserved=max((s['inflight'] for s in scheduler_samples), default=None),
                         schedulerSamples=scheduler_samples,
                         validCompletions=sum(r['validCompletion'] for r in rows.values()), errors=errors,
                         reviews=reviews, decisions=decisions, rows=list(rows.values())))
        result = dict(schema=1, mode=args.mode, source=args.source, workload=config,
                      workloadSha256=hashlib.sha256(config_path.read_bytes()).hexdigest(),
                      conditions=dict(python=sys.version, platform=platform.platform(), executorWorkers=4,
                                      sqlite='existing Ledger factory; WAL + FULL receipt transactions',
                                      jobInputsSha256=hashlib.sha256(json.dumps([receipt(j['eventId']) for j in config['jobs']], sort_keys=True).encode()).hexdigest()),
                      clock='monotonic relative seconds; persisted timestamps UTC wall clock',
                      limitations=['Native transport delay and review delay are simulated',
                                   'No authenticated native invocation or model response measured',
                                   'All arrivals at t0; baseline parent handles serially',
                                   'durableCommittedAt observes transaction commit+close return, not isolated fsync cost',
                                   'baseline firstClaim is missing because baseline has no verification queue'], runs=runs)
        Path(args.result).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(dict(result=args.result, repeats=len(runs), durations=[r['duration'] for r in runs])))

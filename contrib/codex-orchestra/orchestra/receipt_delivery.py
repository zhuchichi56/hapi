"""One persistent claim protocol for worker outbox delivery and native wake.

A durable sending claim precedes I/O. Expired claims become unknown, never
pending. Only an explicit known-not-sent outcome permits bounded retries.
"""

import json
import uuid
from dataclasses import dataclass
from datetime import timedelta

from .constants import BRIDGE_SOCKET, CONTROLLER_THREAD_ID
from .errors import BridgeError, NotFoundError, TransitionError, ValidationError
from .receipts import (LEASE_SECONDS, MAX_ATTEMPTS, RETRY_SECONDS, encoded, ident,
                       normalize_receipt)
from .util import parse_iso

TABLES = {'receipt': 'receipt_outbox', 'wake': 'receipt_wakes'}


@dataclass(frozen=True)
class Outcome:
    status: str  # sent | not-sent | unknown | failed
    code: str
    native_turn_id: str = None


class ReceiptRejected(BridgeError):
    """Explicit terminal rejection before receive commit, from a trusted receiver."""


class LedgerReceiver:
    """Receiver facade. Clients never open SQLite; receive/read are Ledger APIs.

    An external transport must implement the same receive_receipt/get_receipt
    protocol and expose is_test; absence of a read result is never retry proof.
    """
    def __init__(self, ledger):
        self.ledger = ledger
        self.is_test = ledger.receipt_test_mode

    def receive_receipt(self, payload):
        try:
            return self.ledger.receive_receipt(payload)
        except (ValidationError, TransitionError, NotFoundError):
            raise ReceiptRejected('receipt rejected before commit') from None

    def get_receipt(self, event_id):
        return self.ledger.get_receipt(event_id)


def _table(queue):
    if queue not in TABLES:
        raise ValidationError('queue must be receipt or wake')
    return TABLES[queue]


def enqueue(ledger, data):
    payload = normalize_receipt(data)
    event_id = payload['eventId']
    raw = encoded(payload)
    with ledger._receipt_tx() as connection:
        current = connection.execute('SELECT * FROM receipt_outbox WHERE event_id=?', (event_id,)).fetchone()
        if current:
            if current['payload'] != raw:
                raise TransitionError('outbox eventId payload collision')
        else:
            ledger._receipt_task(connection, payload)
            now = ledger._receipt_now()
            connection.execute(
                'INSERT INTO receipt_outbox(event_id,payload,status,next_attempt_at,created_at,updated_at,is_test) '
                "VALUES (?,?,'pending',?,?,?,?)",
                (event_id, raw, now, now, now, int(ledger.receipt_test_mode)))
    return status(ledger, event_id, 'receipt')


def status(ledger, event_id, queue):
    table = _table(queue)
    with ledger._receipt_tx(False) as connection:
        row = connection.execute('SELECT * FROM %s WHERE event_id=?' % table,
                                 (ident(event_id, 'eventId'),)).fetchone()
        if row is None:
            raise NotFoundError('unknown %s queue event' % queue)
        result = dict(eventId=row['event_id'], queue=queue, status=row['status'], attempts=row['attempts'],
                      leaseUntil=row['lease_until'], nextAttemptAt=row['next_attempt_at'],
                      lastCode=row['last_code'], createdAt=row['created_at'], updatedAt=row['updated_at'],
                      isTest=bool(row['is_test']))
        if queue == 'wake':
            result['nativeTurnId'] = row['native_turn_id']
        return result


def _claim(ledger, event_id, queue):
    table = _table(queue)
    event_id = ident(event_id, 'eventId')
    with ledger._receipt_tx() as connection:
        row = connection.execute('SELECT * FROM %s WHERE event_id=?' % table, (event_id,)).fetchone()
        if row is None:
            raise NotFoundError('unknown %s queue event' % queue)
        now = ledger._receipt_now()
        if row['status'] == 'sending':
            if row['lease_until'] and parse_iso(row['lease_until']) > parse_iso(now):
                return None
            connection.execute("UPDATE %s SET status='unknown',lease_until=NULL,last_code='claim-expired',updated_at=? "
                               'WHERE event_id=?' % table, (now, event_id))
            connection.execute("UPDATE receipt_attempts SET status='unknown',code='claim-expired',finished_at=? "
                               "WHERE queue=? AND event_id=? AND claim_token=? AND status='sending'",
                               (now, queue, event_id, row['claim_token']))
            row = connection.execute('SELECT * FROM %s WHERE event_id=?' % table, (event_id,)).fetchone()
        if row['status'] in ('sent', 'failed'):
            return None
        if row['lease_until'] and parse_iso(row['lease_until']) > parse_iso(now):
            return None
        if row['status'] == 'pending' and parse_iso(row['next_attempt_at']) > parse_iso(now):
            return None
        token = uuid.uuid4().hex
        lease = (parse_iso(now) + timedelta(seconds=LEASE_SECONDS)).isoformat(timespec='microseconds')
        mode = 'reconcile' if row['status'] == 'unknown' else 'send'
        if mode == 'send' and row['attempts'] >= MAX_ATTEMPTS:
            connection.execute("UPDATE %s SET status='failed',last_code='retry-exhausted',updated_at=? WHERE event_id=?" % table,
                               (now, event_id))
            return None
        new_status = 'unknown' if mode == 'reconcile' else 'sending'
        attempts = row['attempts'] + int(mode == 'send')
        connection.execute('UPDATE %s SET status=?,attempts=?,claim_token=?,lease_until=?,updated_at=? WHERE event_id=?' % table,
                           (new_status, attempts, token, lease, now, event_id))
        if mode == 'send':
            connection.execute('INSERT INTO receipt_attempts(queue,event_id,claim_token,attempt,status,started_at) '
                               "VALUES (?,?,?,?,'sending',?)", (queue, event_id, token, attempts, now))
        claim = dict(row)
        claim.update(mode=mode, claim_token=token, attempts=attempts, claimed_status=new_status)
        return claim


def _finish(ledger, queue, claim, outcome):
    table = _table(queue)
    if not isinstance(outcome, Outcome) or outcome.status not in ('sent', 'not-sent', 'unknown', 'failed'):
        outcome = Outcome('unknown', 'invalid-outcome')
    if queue == 'wake' and outcome.status == 'sent':
        try:
            ident(outcome.native_turn_id, 'nativeTurnId')
        except ValidationError:
            outcome = Outcome('unknown', 'missing-native-evidence')
    # Persist only a bounded code, never arbitrary exception/native text.
    if not isinstance(outcome.code, str) or not outcome.code or len(outcome.code) > 80 or any(
            char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-' for char in outcome.code):
        outcome = Outcome('unknown', 'invalid-outcome-code')
    # Reconciliation can only prove sent, never prove a previous send absent.
    if claim['mode'] == 'reconcile' and outcome.status != 'sent':
        outcome = Outcome('unknown', 'reconcile-unconfirmed')
    new_status = outcome.status
    if new_status == 'not-sent':
        new_status = 'pending' if claim['attempts'] < MAX_ATTEMPTS else 'failed'
    with ledger._receipt_tx() as connection:
        now = ledger._receipt_now()
        next_at = (parse_iso(now) + timedelta(seconds=RETRY_SECONDS * 2 ** max(0, claim['attempts'] - 1))).isoformat(timespec='microseconds')
        params = [new_status, next_at, outcome.code, now]
        native_sql = ''
        if queue == 'wake':
            native_sql = ',native_turn_id=?'
            params.append(outcome.native_turn_id)
        params.extend((claim['event_id'], claim['claim_token'], claim['claimed_status']))
        changed = connection.execute(
            'UPDATE %s SET status=?,next_attempt_at=?,last_code=?,updated_at=?,lease_until=NULL%s '
            'WHERE event_id=? AND claim_token=? AND status=?' % (table, native_sql), params).rowcount
        if changed and claim['mode'] == 'send':
            connection.execute('UPDATE receipt_attempts SET status=?,code=?,finished_at=? WHERE queue=? AND event_id=? AND claim_token=?',
                               ('failed' if outcome.status == 'not-sent' else outcome.status,
                                outcome.code, now, queue, claim['event_id'], claim['claim_token']))
        elif changed and claim['mode'] == 'reconcile' and new_status == 'sent':
            connection.execute("UPDATE receipt_attempts SET status='sent',code='read-reconciled',finished_at=? "
                               "WHERE queue=? AND event_id=? AND status='unknown'",
                               (now, queue, claim['event_id']))
    return status(ledger, claim['event_id'], queue)


def _same_receipt(saved, original, is_test):
    if not isinstance(saved, dict):
        return False
    try:
        parse_iso(saved['receivedAt'])
        return (saved.get('receiptId') == original['eventId'] and saved.get('isTest') is is_test
                and normalize_receipt({key: saved[key] for key in original}) == original)
    except (KeyError, ValidationError):
        return False


def dispatch_receipt(ledger, event_id, receiver):
    if getattr(receiver, 'is_test', None) is not ledger.receipt_test_mode:
        raise TransitionError('receiver test scope must match the sender ledger')
    claim = _claim(ledger, event_id, 'receipt')
    if claim is None:
        return status(ledger, event_id, 'receipt')
    original = json.loads(claim['payload'])
    try:
        if claim['mode'] == 'reconcile':
            saved = receiver.get_receipt(event_id)
            outcome = Outcome('sent', 'read-reconciled') if _same_receipt(saved, original, ledger.receipt_test_mode) else Outcome('unknown', 'read-unconfirmed')
        else:
            ack = receiver.receive_receipt(original)
            if (isinstance(ack, dict) and ack.get('ok') is True and ack.get('ack') == 'durable-received'
                    and ack.get('eventId') == event_id and ack.get('receiptId') == event_id
                    and isinstance(ack.get('receivedAt'), str)):
                parse_iso(ack['receivedAt'])
                outcome = Outcome('sent', 'durable-ack')
            else:
                outcome = Outcome('unknown', 'invalid-ack')
    except ReceiptRejected:
        outcome = Outcome('failed' if claim['mode'] == 'send' else 'unknown', 'receiver-rejected')
    except BridgeError as exc:
        outcome = Outcome('not-sent' if exc.delivery == 'not-sent' else 'unknown', 'transport-' +
                          ('not-sent' if exc.delivery == 'not-sent' else 'unknown'))
    except Exception:
        outcome = Outcome('unknown', 'transport-unknown')
    return _finish(ledger, 'receipt', claim, outcome)


def dispatch_wake(ledger, event_id, adapter):
    if ledger.receipt_test_mode and getattr(adapter, 'is_test', False) is not True:
        raise TransitionError('test ledger cannot call a live native adapter')
    if getattr(adapter, 'controller_id', None) != CONTROLLER_THREAD_ID:
        raise TransitionError('wake target is not the authorized controller')
    claim = _claim(ledger, event_id, 'wake')
    if claim is None:
        return status(ledger, event_id, 'wake')
    try:
        if claim['mode'] == 'reconcile':
            outcome = adapter.reconcile(event_id)
        elif callable(getattr(adapter, 'send_attempt', None)):
            # Native bridge caches failed action IDs. Each proven-safe wire
            # attempt uses its durable claim token; the business marker stays stable.
            outcome = adapter.send_attempt(event_id, 'orchestra_receipt_' + claim['claim_token'])
        else:
            outcome = adapter.send(event_id)
    except BridgeError as exc:
        outcome = Outcome('not-sent' if exc.delivery == 'not-sent' else 'unknown', 'transport-' +
                          ('not-sent' if exc.delivery == 'not-sent' else 'unknown'))
    except Exception:
        outcome = Outcome('unknown', 'transport-unknown')
    return _finish(ledger, 'wake', claim, outcome)


def drain(ledger, *, receiver=None, wake_adapter=None, limit=20):
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValidationError('drain limit must be 1..100')
    results = []
    for queue, transport in (('receipt', receiver), ('wake', wake_adapter)):
        if transport is None:
            continue
        with ledger._receipt_tx(False) as connection:
            now = ledger._receipt_now()
            events = [row['event_id'] for row in connection.execute(
                "SELECT event_id FROM %s WHERE (status='pending' AND next_attempt_at<=?) "
                "OR (status='sending' AND (lease_until IS NULL OR lease_until<=?)) "
                "OR (status='unknown' AND (lease_until IS NULL OR lease_until<=?)) "
                "ORDER BY updated_at,event_id LIMIT ?" % _table(queue), (now, now, now, limit))]
        for event_id in events:
            fn = dispatch_receipt if queue == 'receipt' else dispatch_wake
            results.append(fn(ledger, event_id, transport))
    return results


class NativeWakeAdapter:
    """Installed bridge send/read adapter. No native response text is stored.

    HTTP 200 + ok alone is insufficient. Every successful send must be followed
    by a native read showing the exact injected user marker in this controller.
    Only the installed bridge's explicit delivery=not-sent permits retry.
    """
    controller_id = CONTROLLER_THREAD_ID
    is_test = False

    def __init__(self, *, post=None, socket_path=BRIDGE_SOCKET):
        if post is None:
            from .bridge import post_command
            self.post = lambda command: post_command(command, socket_path=socket_path)
        else:
            self.post = post

    @staticmethod
    def marker(event_id):
        return '[orchestra-receipt:%s]' % ident(event_id, 'eventId')

    def send_attempt(self, event_id, action_id):
        return self.send(event_id, action_id=action_id)

    def send(self, event_id, *, action_id=None):
        marker = self.marker(event_id)
        action_id = action_id or ('orchestra_receipt_' + uuid.uuid4().hex)
        command = dict(app='codex', op='send', id=self.controller_id, actionId=action_id,
                       text=marker + ' Task review pending. Read with: codex-orchestra receipt-get ' + event_id +
                       '. Independently review evidence before deciding; durable ACK is not acceptance. '
                       'Do not reply with ACK-only recursion.')
        status_code, payload = self.post(command)
        if not isinstance(payload, dict):
            return Outcome('unknown', 'native-invalid-payload')
        if status_code != 200 or payload.get('ok') is not True:
            # Never infer not-sent from HTTP status, native error text, or a
            # failed action receipt. Native errors remain ambiguous by default.
            return Outcome('not-sent', 'native-not-sent') if payload.get('delivery') == 'not-sent' else Outcome('unknown', 'native-unknown')
        return self.reconcile(event_id)

    def reconcile(self, event_id):
        marker = self.marker(event_id)
        try:
            status_code, payload = self.post(dict(app='codex', op='read', id=self.controller_id, limit=20))
        except Exception:
            return Outcome('unknown', 'native-read-failed')
        if status_code != 200 or not isinstance(payload, dict) or payload.get('ok') is not True:
            return Outcome('unknown', 'native-read-failed')
        result = payload.get('result')
        if not isinstance(result, dict) or result.get('id') != self.controller_id:
            return Outcome('unknown', 'native-read-mismatch')
        turns = result.get('turns')
        if not isinstance(turns, list):
            return Outcome('unknown', 'native-read-unconfirmed')
        for turn in turns:
            if not isinstance(turn, dict) or not isinstance(turn.get('items'), list):
                continue
            for item in turn['items']:
                # Restrict to actual native user items. An assistant quoting an
                # event marker is not a native delivery receipt.
                if (isinstance(item, dict) and item.get('role') == 'user'
                        and isinstance(item.get('text'), str) and item['text'].startswith(marker + ' ')):
                    try:
                        turn_id = ident(turn.get('id'), 'nativeTurnId')
                    except ValidationError:
                        continue
                    return Outcome('sent', 'native-read-marker', turn_id)
        return Outcome('unknown', 'native-read-unconfirmed')

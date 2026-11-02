"""Frozen T021 public-safe projection; never copies arbitrary internal strings."""

from .errors import ValidationError
from .util import parse_iso

PUBLIC_RECORD_KEYS = ('decisionId', 'taskId', 'stageId', 'revision', 'decisionRequired', 'authority',
                      'waitingOn', 'state', 'triggeredAt', 'pendingSince', 'decidedAt', 'actionConfirmedAt', 'verifiedAt',
                      'dueAt', 'clock', 'test', 'rework', 'revoked', 'question', 'nextAction', 'owner')
CLOCK = 'orchestra-ledger-received-utc/v1'


def safe_display(data):
    if data is None:
        return dict(question=None, nextAction=None, owner=None)
    if not isinstance(data, dict) or set(data) - {'question', 'nextAction', 'owner'}:
        raise ValidationError('publicDisplay must contain only dedicated safe question/nextAction/owner')
    result = {}
    for key in ('question', 'nextAction', 'owner'):
        value = data.get(key)
        if value is not None and (not isinstance(value, str) or not value.strip() or len(value) > 160
                                  or any(ord(char) < 32 for char in value)):
            raise ValidationError('dedicated public display fields must be null or safe text <=160 chars')
        result[key] = value
    return result


def project(internal):
    decisions = []
    for record in internal['decisions']:
        # Only controller-declared dedicated display values can enter this
        # projection. No fallback to raw trigger, action, owner, or evidence.
        display = safe_display(record.get('publicDisplay'))
        active = record['disposition'] != 'revoked'
        waiting = (record['authority'] if record['state'] == 'pending' else
                   'external' if record.get('actionConfirmedAt') is None else 'controller')
        if not active or record['state'] == 'verified':
            waiting = None
        item = dict(decisionId=record['decisionId'], taskId=record['taskId'], stageId=record['stageId'],
                    revision=record['revision'], decisionRequired=record['decisionRequired'], authority=record['authority'],
                    waitingOn=waiting, state=record['state'], triggeredAt=record.get('triggeredAt'),
                    pendingSince=record.get('pendingSince') if record['state'] == 'pending' else None,
                    decidedAt=record['firstDecidedAt'], actionConfirmedAt=record.get('actionConfirmedAt'),
                    verifiedAt=record['verifiedAt'], dueAt=record['dueAt'], clock=record.get('clock'),
                    test=record['isTest'], rework=record['reworkCount'] > 0, revoked=record['revokedCount'] > 0,
                    question=display['question'], nextAction=display['nextAction'], owner=display['owner'])
        assert set(item) == set(PUBLIC_RECORD_KEYS)
        decisions.append(item)
    return dict(version=1, projection='T022-public-safe/v1', safeDisplay=True,
                generatedAt=internal['generatedAt'], statisticsStartAt=internal['statisticsStartAt'], clock=CLOCK,
                coverage=dict(currentComplete=True, historyComplete=internal['statisticsStartAt'] is not None,
                              firstDecisionAtImmutable=True), decisions=decisions)


def elapsed(start, end):
    if start is None or end is None:
        return None
    seconds = (parse_iso(end) - parse_iso(start)).total_seconds()
    return seconds if seconds >= 0 else None  # Invalid clocks remain unknown, never clamped/fabricated.

"""Clear only a proved-resolved archive error, preserving a diagnostic receipt."""

import json
import re
from .util import now_iso


def clear_resolved_archive_error(ledger):
    connection = ledger._connect()
    try:
        with connection:
            error = ledger._meta(connection, 'collector_error')
            match = re.fullmatch(r'archive-run ([A-Za-z0-9_-]+) failed: [A-Za-z0-9_]+', error or '')
            if not match:
                return False
            task_id = match[1]
            task = connection.execute('SELECT review,archive FROM tasks WHERE id=?', (task_id,)).fetchone()
            if task is None or task['review'] != 'accepted' or task['archive'] != 'archived':
                return False
            request = connection.execute("SELECT 1 FROM operations WHERE task_id=? AND kind='archive_request' AND status='reconciled'", (task_id,)).fetchone()
            receipts = connection.execute("SELECT payload FROM operations WHERE task_id=? AND kind='archive_receipt'", (task_id,)).fetchall()
            confirmed = False
            for receipt in receipts:
                try:
                    confirmed |= json.loads(receipt['payload']).get('result') == 'confirmed'
                except (TypeError, ValueError, AttributeError):
                    pass
            if request is None or not confirmed:
                return False
            ledger._set_meta(connection, 'last_resolved_archive_error', json.dumps({
                'taskId': task_id, 'error': error, 'resolvedAt': now_iso(),
                'reason': 'accepted, archived, reconciled request and confirmed receipt; no native action'
            }))
            ledger._set_meta(connection, 'collector_error', None)
            return True
    finally:
        connection.close()

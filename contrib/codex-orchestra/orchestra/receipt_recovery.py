"""Bounded recovery polling on the existing collector cadence/executor.

No new thread pool, service, port or timer. Immediate receive wake remains the
primary event path; recovery only resumes durable pending/unknown queues.
"""

import time

from .collector import Collector
from .receipt_delivery import LedgerReceiver, NativeWakeAdapter


class ReceiptRecoveryCollector(Collector):
    def __init__(self, ledger, *args, recovery_adapter=None, recovery_limit=5, **kwargs):
        super().__init__(ledger, *args, **kwargs)
        self.recovery_adapter = recovery_adapter or NativeWakeAdapter(socket_path=self.socket_path)
        self.recovery_limit = recovery_limit
        self.ledger.wake_adapter = self.recovery_adapter
        self._receipt_recovery_due = 0.0
        self._receipt_recovery_future = None
        self.ledger.set_meta('receipt_recovery_mode', 'existing-collector-cadence-recovery-polling')

    def _maybe_recover_receipts(self):
        now = time.monotonic()
        future = self._receipt_recovery_future
        if future is not None:
            if not future.done():
                return
            try:
                future.result()
            except Exception:
                self.ledger.set_meta('receipt_recovery_error', 'receipt-recovery-failed')
            self._receipt_recovery_future = None
        if now < self._receipt_recovery_due or self._closed:
            return
        self._receipt_recovery_due = now + self.interval
        self._receipt_recovery_future = self._executor.submit(self._recover_receipts)

    def _recover_receipts(self):
        # Same ledger/API and fixed controller; no SQL bypass by a transport.
        result = self.ledger.drain_receipts(receiver=LedgerReceiver(self.ledger),
                                           wake_adapter=self.recovery_adapter, limit=self.recovery_limit)
        self.ledger.set_meta('receipt_recovery_error', '')
        return result

    def _submit_available(self):
        self._maybe_recover_receipts()
        return super()._submit_available()

    def _drain(self, timeout):
        self._maybe_recover_receipts()
        return super()._drain(timeout)

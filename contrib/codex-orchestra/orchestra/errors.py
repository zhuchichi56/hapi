"""Typed, non-sensitive errors for the Codex Orchestra backend."""


class OrchestraError(Exception):
    """Base class for expected operator-facing errors."""


class ValidationError(OrchestraError):
    """Input did not satisfy the ledger contract."""


class NotFoundError(OrchestraError):
    """The requested task, operation, or notice does not exist."""


class TransitionError(OrchestraError):
    """A state transition is not allowed or conflicts with persisted state."""


class BridgeError(OrchestraError):
    """The native Codex read bridge failed or returned an unusable payload."""

    def __init__(self, message, delivery=None):
        super().__init__(message)
        # "not-sent" is the only safe-to-retry delivery class; everything else
        # (including timeouts) is treated as an unknown native outcome.
        self.delivery = delivery

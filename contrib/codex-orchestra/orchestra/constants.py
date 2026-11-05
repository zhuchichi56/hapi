"""Frozen contract values for the local Codex Orchestra backend."""

VERSION = 1

CONTROLLER_THREAD_ID = "01a1a900-f470-7a70-970e-3dcfea8e4abd"
# Replaced 2026-11-05: its history was poisoned by foreign tool-call ids. Kept archive-protected; never a controller.
RETIRED_CONTROLLER_THREAD_ID = "01a19339-39e6-7081-8920-82db9992402a"
T008_THREAD_ID = "01a19807-55f8-7561-865b-78f387a5aad7"

# This controller and the T008 implementation chat are deliberately protected
# from automatic/CLI archive until the external controller handles them later.
PROTECTED_THREAD_IDS = frozenset({CONTROLLER_THREAD_ID, RETIRED_CONTROLLER_THREAD_ID, T008_THREAD_ID})

BRIDGE_SOCKET = "/Users/zhuhe/.local/state/native-desktop-bridge/host.sock"
BRIDGE_READ_LIMIT = 2
BRIDGE_TIMEOUT_SECONDS = 3.0

POLL_INTERVAL_SECONDS = 5.0
WORKER_COUNT = 4
STALE_AFTER_SECONDS = 30.0

PROGRESS_LIMIT = 1200

EXECUTIONS = (
    "queued",
    "running",
    "reported",
    "failed",
    "interrupted",
    "unknown",
    "blocked",
)
REVIEWS = ("pending", "awaiting", "accepted", "rejected")
ARCHIVES = ("none", "pending", "archived", "unknown")
HOSTS = ("local",)
TURN_STATUSES = ("inProgress", "completed", "failed", "interrupted")

# Only these two notice classes are persisted. Disconnects are surfaced by
# stale/error markers instead of notification spam.
NOTICE_KINDS = ("delivery", "blocked")

IMPORT_SOURCE_OBSERVED_AT = "2026-11-01T13:27:00+08:00"
IMPORT_AUTHORIZATION = (
    "import-markdown: outputs/任务总览.md（只读导入，未重新派发或执行）"
)

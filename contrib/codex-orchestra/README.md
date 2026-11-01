# Codex Orchestra

Open the existing authenticated Desktop at
<https://desktop.urbanclaw.net/desktop?app=codex&view=orchestra>.
The sidebar also has a **任务总控** entry. The board is read-only and shows
registered work, public progress, independent execution/review/archive states,
checkpoints, evidence, and explicitly stale external history.

The controller is scoped to native Codex thread
`01a19339-39e6-7081-8920-82db9992402a`. Its actual local skill is in
`/Users/zhuhe/Documents/Codex/2026-11-01/new-chat/.agents/skills/codex-orchestra/`;
`controller-skill/SKILL.md` is the versioned installation source. Nothing installs
a global skill or modifies global AGENTS.

## Local service

Python stdlib only. Existing uv-managed Python is used by the installer.

```sh
uv run --no-project python contrib/codex-orchestra/install.py install --mini-tunnel
uv run --no-project python contrib/codex-orchestra/install.py start --mini-tunnel
~/.local/bin/codex-orchestra snapshot
~/.local/bin/codex-orchestra consume
```

The installed CLI is `~/.local/bin/codex-orchestra`; the program is
`~/.local/lib/codex-orchestra/`; the sole ledger is
`~/.local/state/codex-orchestra/orchestra.db`. State is private (0700 directory,
0600 DB/socket). No TCP management listener is added. A separate SSH Unix-socket
forward goes to the existing Mini Hub; it does not replace the original Desktop
forward, model gateway, or executor. `install.py status/start/stop/restart`, with
optional `--mini-tunnel`, manages only these two owned LaunchAgents. Stop/restart
preserves SQLite and does not stop any work chat. Restart waits for launchd unload
before loading the service again.

The service polls only registered non-archived local Codex work. Archived imports
are not repolled and external historical rows are never adopted or mutated. Only
public assistant commentary/final text and generic tool states are retained;
raw user/tool/reasoning content is discarded at the adapter. Completion requires
an explicit native completed turn and only enters awaiting review. Native status
comes from the already installed private Desktop bridge; this is an internal
protocol and can break after an App upgrade. Unknown/outages retain verified
results and become stale. There are no background model calls.

## Controller workflow

See `controller-skill/SKILL.md` and `BACKEND.md` for exact arguments. Register a
complete JSON contract, persist `dispatch-intent`, then use the real App
`create_thread` tool and `bind` its actual result. A pending `clientThreadId` has
its own persisted receipt. Existing/uncertain operations are reconciled before
any further native action. The service never starts a second model executor.

After checking actual output, record `review ... --result accepted`, then
`archive-request`. The installed collector opts into archive execution of these
explicit requests only. It first checks native archived identity; persists
attempting; sends at most one mutation per attempt; retains unknown results for
read-only reconciliation. Explicit not-sent/rejected retries back off 4/8 seconds,
stop after three attempts, and preserve accepted review. The controller is always
protected. T008 is eligible only after its parent has accepted it. Manual native
archive plus `archive-receipt` remains possible. `consume` never deletes notices;
`ack` records handling separately.

Markdown is an explicitly generated timestamped snapshot, not another queue:

```sh
codex-orchestra export-md '/Users/zhuhe/Documents/Codex/2026-11-01/new-chat/outputs/任务总览-账本快照.md' --force
```

The old `任务总览.md` is preserved, and export refuses to overwrite an imported
source even with `--force`.

## Deployment and rollback

`integrate-hapi.py ROOT` applies only four small integration edits to a **current**
HAPI source copy and fails on missing/ambiguous markers. Copy the new board and
route beside them. Build against current production customizations; do not copy
an old complete source tree over production. `deploy-mini.py` is the audited T008
one-shot deployment recipe, pinned to its actual pre-deploy binary hash; it is
not a generic repeatable upgrade command. It verifies all unaffected sources,
backs up the exact binary and changed sources, installs atomically and reloads
only the known Hub listener.

Installed rollback:

```sh
ssh mac-mini 'python3 ~/.local/lib/hapi-mini/rollback-orchestra-t008.py'
```

Rollback refuses to overwrite later binary/source changes and leaves the ledger
intact. Then stop the owned collector/tunnel if desired. Neither path writes a
Codex private database or changes existing automation, GPU jobs or gateway config.

## Verification

```sh
cd contrib/codex-orchestra
uv run --no-project python -m unittest -v test_orchestra.py
# Existing HAPI Bun dependencies:
bun test hub/src/web/routes/orchestra.test.ts
bun run test:web src/components/nativeDesktop/OrchestraBoard.test.tsx
```

Tests cover import identity, explicit completion, stale/old callbacks, pending
create reconciliation, restart/notices, fair concurrent collection, archive
unknown outcomes and attempt limits, owner auth, bounded socket proxying,
visibility polling, retained snapshots and HTML escaping. Real end-to-end
acceptance and deployment/performance receipts are delivered to the controller's
`outputs/总控系统实现/` folder.

## Current limits

The deterministic service updates the board and persistent notice inbox. It does
**not** wake the controller model or send phone notifications. The controller
consumes notices on its next natural turn; no high-frequency LLM automation was
created. Frontend data requests are cancelled after four seconds and retain the
last snapshot. A 401 currently requires the existing login/reload flow; this
board's direct fetch does not add a separate token refresh flow. Native source
message timestamps are unavailable; observation time is explicit and source time
remains unknown. Program concurrency tests do not establish the model/controller's
10-second response latency. Existing occasional public Cloudflare failures also
remain outside this change.

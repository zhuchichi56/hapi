# Runtime patches — bounded private loopback ports for WWX

## Why

The stock CLI binds several loopback servers on port 0 (kernel-chosen). The
WWX Seatbelt profile cannot allow "all of localhost" without also exposing the
owner's unauthenticated dynamic endpoints (3006 hub, 4150 gateway, 50641/51916
session control ports). Seatbelt also rejects port ranges
(`localhost:43100-43131` → `invalid port in network address`, measured), so the
profile must list exact literals.

## What the patch does

`apply.sh` injects `src/utils/guestPort.ts` and rewrites five call sites:

| file | before | after |
|---|---|---|
| `src/runner/controlServer.ts` | `app.listen({port:0})` | `HAPI_RUNNER_CONTROL_PORT` or pool |
| `src/claude/utils/startHappyServer.ts` | `server.listen(0)` | pool |
| `src/claude/utils/startHookServer.ts` | `server.listen(0)` | pool |
| `src/codex/shared/runtime.ts` | `freePort()` probes `listen(0)` | pool reservation |
| `src/codex/shared/gateway.ts` | `server.listen(0)` | pool |

The allocator reserves ports atomically via lock directories under
`$HAPI_HOME/tmp/guest-ports`; stale locks are reclaimed by PID liveness. When
`HAPI_GUEST_PORT_MIN/MAX` are unset it returns 0 and the original port-0
behaviour remains (owner runtime is untouched). When the range is exhausted it
throws instead of falling back to a dynamic port.

Ports: `43100..43131` (32 literals), hub `3026`, proxy `4126`. No wildcard.

## Build and native process support

Use a full workspace copy as described in the parent README, then run
`build.sh <copy>/cli <outdir>`. It validates the compiled binary with the
`--guest-port-probe` behavior and writes its SHA-256; Bun binaries are not
validated by grepping for plaintext constants.

The patch also adds guest-only Darwin process queries, including process tree
and orphan discovery, and moves Codex engine sockets into the guest TMPDIR.
System setuid ps remains untouched. See the parent README for real sandbox and
public end-to-end validation.

## Not covered (fail closed)

Other agents' dynamic loopback servers (`opencode/utils/startOpencodeHookServer.ts`,
`cursor` MCP overlay, test/globalSetup) are intentionally not patched; WWX core
is runner + Codex + Claude. If a future agent needs a server, either patch it
into the same pool or leave that agent unavailable. Do not add wildcard
localhost to the profile.

## Limits

- The allocator reserves but does not bind-probe; if a foreign process owns a
  reserved port, the server fails to start rather than silently escaping the
  pool. Core paths fail closed.
- This patch does not change hub auth, model credentials, or central proxy
  behaviour.

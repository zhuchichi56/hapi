# Mini Hub release entrypoint

The Mini HAPI Hub runs as a root-owned LaunchDaemon
(`system/com.zhuhe.hapi-mini`) with `KeepAlive` and `ThrottleInterval=10`.
The old installer atomically replaced `bin/hapi-hub`, sent SIGTERM to the
listener, and relied on KeepAlive. On 2026-11-02 the first replacement was
rejected by macOS (`OS_REASON_CODESIGNING` / Launch Constraint Violation) and the
service stayed down until the job was registered again. The installer had no
candidate signing preflight and no automatic rollback.

`contrib/mini-hub-release/hapi_release.py` (COMPACT_RELEASE_V1) replaces that
sequence for binary-only releases. It does not rebuild source, does not touch
`builds/quick-session-20261026`, and does not modify the LaunchDaemon plist.

## One transaction

1. Read the existing plist with `plistlib`; validate label, binary argv, and a
   loopback `HAPI_LISTEN_HOST`. The plist file and its environment (tenant,
   `HAPI_HOME`, proxies, `UserName`) are reused verbatim and checked for drift.
2. Require the exact expected current binary SHA-256, take a process-held
   non-blocking lock, and verify the live SHA again before stopping anything.
3. Stage a candidate copy at `<base>/bin/.release-stage-...` with a new inode on the
   live binary's volume. Validate thin arm64 Mach-O and
   `codesign --verify --strict`; invalid signatures are rejected. The helper does
   not ad-hoc re-sign or drop entitlements.
4. Start the staged candidate in an isolated temporary `HOME`/`HAPI_HOME`/database
   on loopback with `--no-relay`, push/notifications off, and a scrubbed
   environment. Verify `/health` JSON (`status: ok`, integer `protocolVersion`),
   `/desktop`, and its referenced `/assets/*.js` content.
5. Snapshot the live binary, `launchctl bootout system/com.zhuhe.hapi-mini`, wait
   boundedly for the old PID to exit, atomically install the staged candidate,
   then `launchctl bootstrap system` with the existing plist.
6. Verify the new PID's executable path, exactly one listener, `/health`,
   `/desktop` asset, and a short PID-stability window.
7. On any post-bootout failure or catchable interruption, restore the exact
   binary snapshot and bootstrap again, then verify readiness. SQLite is never
   copied or rolled back.

The receipt is written under `<base>/release-state/receipts/` with `result` one
of `rejected`, `deployed`, `rolled-back`, or `rollback-failed`, plus hashes,
timestamps, old/new PIDs, bounded recovery time, and error codes. It never
contains environment values, auth tokens, raw logs, or candidate contents.

## Commands and verification

Use the installed `/Users/zhuhe/.local/lib/hapi-mini/bin/hapi-release.py` on `mac-mini`. The exact `status`, `preflight`, `deploy`, and guarded `rollback` commands are maintained in [`contrib/mini-hub-release/README.md`](../contrib/mini-hub-release/README.md). Record the expected binary hash with the source/build baseline; do not compute a fresh hash at apply time to conceal concurrent changes.

The incident's old `install-project-tree.py` is retired with its original preserved. Runtime and live build rules require the new entrypoint for future updates. Binary deployment uses the existing LaunchDaemon and does not alter its authentication or tenant configuration.

The focused test suite passes. On the Mini, the current real Hub passed the isolated candidate probe with page/script hashes matching production. A deliberately invalid signed candidate and a deployment without administrator rights were both rejected while the live PID and binary hash stayed unchanged. Privileged production restart acceptance is a separate final operator step.

## Limits

- The candidate probe proves startup and unauthenticated health/desktop asset
  serving only; it is not a full session/relay/push/tenant acceptance test.
- Thin arm64 only; invalid signatures reject rather than being re-signed.
- Bounded waits avoid restart loops. SIGKILL, panic, or power loss during the
  transaction cannot execute rollback; the last receipt/snapshot is recovery
  evidence and manual restore may be required.
- Binary-only rollback is intentional. Never restore the SQLite DB.
- Do not weaken launch constraints, Gatekeeper/SIP/AMFI, or authentication to
  work around a signing failure.

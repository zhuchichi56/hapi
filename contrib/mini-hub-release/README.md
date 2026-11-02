# Mini Hub releases

Use this helper for the existing `system/com.zhuhe.hapi-mini` LaunchDaemon. The installed entry is `/Users/zhuhe/.local/lib/hapi-mini/bin/hapi-release.py` on `mac-mini`.

The release transaction checks the recorded baseline hash, holds a process lock, copies the candidate to a new inode beside the live binary, and verifies its arm64 Mach-O header and strict code signature. It starts that copy in a temporary home/database with loopback networking and push/notifications/relay disabled. Health JSON, the Desktop page, its script asset and the candidate listener identity must pass before the live service is stopped.

It then saves the previous binary, unregisters the existing launchd job, waits for its PID to exit, atomically installs the candidate and registers the same plist again. Verification checks the new listener PID/executable, page/script hashes, health protocol and a short stability window. A failed launch or catchable interruption triggers the same controlled restart with the previous binary. Rollback never rewinds the live database or source tree. The plist and its environment are preserved verbatim and checked for drift.

The helper rejects invalid signatures; it does not re-sign executables or change macOS security policy. Candidates must be thin arm64 executables. It uses Python 3.9+ and the existing macOS `codesign`, `launchctl`, `lsof` and libproc facilities.

## Commands on the Mini

Global options `--base` and `--plist` go before the subcommand. Defaults match the existing installation. Record the live hash **before building or merging a candidate** and retain it through deployment. Do not recompute it at apply time to bypass a concurrent deployment.

```sh
# Capture once as part of the build/source baseline.
python3 /Users/zhuhe/.local/lib/hapi-mini/bin/hapi-release.py status
EXPECTED_CURRENT_SHA='paste-the-recorded-baseline-SHA256'
CANDIDATE='/absolute/path/to/reviewed/hapi-hub'

python3 /Users/zhuhe/.local/lib/hapi-mini/bin/hapi-release.py preflight \
  --candidate "$CANDIDATE" --expected-current-sha "$EXPECTED_CURRENT_SHA"

sudo /usr/bin/python3 /Users/zhuhe/.local/lib/hapi-mini/bin/hapi-release.py deploy \
  --candidate "$CANDIDATE" --expected-current-sha "$EXPECTED_CURRENT_SHA"
```

`preflight` needs write access for its lock and isolated staging, but does not mutate the live service or executable. `deploy` checks administrator privileges before doing work. Use `--reinstall` only for a deliberate same-version restart. For an interactive sudo prompt over SSH, use `ssh -tt mac-mini`.

Manual rollback also requires a reviewed current hash and a successful deployment receipt:

```sh
sudo /usr/bin/python3 /Users/zhuhe/.local/lib/hapi-mini/bin/hapi-release.py rollback \
  --receipt '/Users/zhuhe/.local/lib/hapi-mini/release-state/receipts/RECEIPT-ID.json' \
  --expected-current-sha 'paste-the-reviewed-current-SHA256'
```

It validates the snapshot and runs it through the same release transaction. Exit codes are `0` for success, `1` for a failed update successfully rolled back, `2` for rejection, and `3` for rollback failure. A manual rollback that succeeds returns 0 with `intent: manual-rollback`.

## Evidence and recovery

Receipts are stored in `release-state/receipts/`; snapshots in `release-state/snapshots/`. After the lock is acquired, the helper persists step timestamps and before/after hashes, snapshot identity, plist hash, PIDs and final result. `updating` without a finish time denotes an interrupted transaction. Privilege and lock rejections return a safe CLI error without a transaction receipt. Raw logs, environment values and authentication data are excluded.

SIGKILL, machine failure or power loss cannot execute Python rollback. The persisted journal and exact snapshot support administrator recovery; an unfinished transaction is not a successful deployment. Disk or launchd failures can also prevent rollback and are reported as `rollback-failed`.

The isolated probe validates startup and public page assets, not production database migrations or all authenticated features. After a real update, verify owner authentication and original Codex/Claude lists through the public route. Preserve tenant isolation and never replay uncertain conversation writes.

## Integration

Install the reviewed file atomically at the installed entry above, preserving the previous helper if one exists. Do not rebuild the Hub from an older clone: current Mini source may include concurrent owner, tenant and UI work.

The incident's `install-project-tree.py` has been retired with a recoverable backup. Its replacement is this release CLI. The runtime and live build `AGENTS.md` point future work here; historical `deploy-*.py` install-and-kill snippets must not be used. Source merging and its rollback remain the responsibility of the specific source change; this helper transacts only the compiled binary.

## Tests

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s contrib/mini-hub-release -p 'test_*.py' -v
```

The suite uses temporary files and an injected platform adapter to exercise the actual transaction: signature/drift/lock rejection, success ordering, bootstrap/readiness failure, interruption, rollback failure, immutable copies, safe receipts, manual rollback and exit codes. Mac adapter checks cover plist preservation, configuration drift and privilege rejection. Native Mini preflight and signature-rejection results must be recorded separately from these tests.

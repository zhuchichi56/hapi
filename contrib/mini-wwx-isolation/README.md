# Mac mini WWX execution account

This deployment runs HAPI's WWX namespace as UID 560 (`hapi-wwx`), with a private
0700 home and root-owned runtime under `/opt/hapi-wwx`. The owner keeps the
existing hub, runner, web code and native desktop bridge.

## Installed layout and boundaries

- Guest hub: `127.0.0.1:3026`; model proxy: `127.0.0.1:4126`.
- Guest control/MCP ports: exactly `43100..43131`; no all-localhost permission.
- Policy/wrapper: `/Library/Application Support/HAPI-WWX-Isolation`.
- Services: `run.hapi.wwx.proxy`, `run.hapi.wwx.hub`, `run.hapi.wwx.runner`.
- Models: Claude `claude-sonnet-5-5`, Codex `gpt-6.1-sol`, via the existing 4150
  model gateway. The guest cannot connect to 4150 or the owner's hub directly.
- The proxy runs under the guest UID outside Seatbelt, with a fixed upstream
  and route/model allowlists. Agent descendants inherit Seatbelt. They cannot
  inspect or signal the owner hub; the real sandbox tests verify this.
- Vendor scratch directories `/private/tmp/claude-560` and
  `/private/tmp/codex-daemon-560` belong to UID 560 with mode 0700. Only the
  latter also permits Unix sockets; all IP network rules remain exact ports.

The public owner hub authenticates the existing opaque WWX web code, then
proxies core REST and SSE requests to the isolated hub with its own
`base:wwx` credential. Owner JWTs/cookies never reach the guest hub. Native
Desktop and other privileged owner routes return 403. The owner's
`tenant-backends.json` is private 0600. No raw credentials belong in this repo.

**Deployment prerequisite:** the owner hub's LaunchDaemon must include both
`NO_PROXY` and `no_proxy` set to `127.0.0.1,localhost,::1`. Its existing external
HTTP(S) proxy otherwise routes the private backend requests to the wrong host.
Preserve other environment fields. Reload only that daemon after editing its
plist, and verify bootstrap completed; a shutdown/bootstrap race can require
waiting for bootout to finish before retrying bootstrap.

## Build and first install

Use a copy of the entire deployed source workspace, with its existing offline
node_modules, shared package and embedded assets. Never patch the owner's
runtime tree. On the Mini:

```sh
cp -cR ~/.local/lib/hapi-mini/builds/quick-session-20261026 \
  ~/.local/lib/hapi-mini/builds/wwx-runtime-20261027
sh runtime-patches/build.sh \
  ~/.local/lib/hapi-mini/builds/wwx-runtime-20261027/cli /tmp/hapi-wwx-build
sudo env WWX_CLI_BIN=/tmp/hapi-wwx-build/hapi \
  WWX_CLAUDE_BIN=/path/to/trusted/native/claude \
  sh package/install.sh --dry-run
sudo env WWX_CLI_BIN=/tmp/hapi-wwx-build/hapi \
  WWX_CLAUDE_BIN=/path/to/trusted/native/claude \
  sh package/install.sh --apply --start
sudo sh package/verify.sh
```

The actual deployed copy is `wwx-runtime-20261027`. The installer refuses an
unpatched binary using `--guest-port-probe`, never a plaintext grep of Bun's
compiled executable. Root installation generates private credentials and an
unknown random account password without printing them. No sudoers changes.
The supplied Claude binary was the existing trusted native arm64 installation.
Do not install or change RJJ as part of this package.

Re-running a full install on an existing/partial layout is refused. Inspect and
repair the specific step; do not remove the account or home to retry. To start
an already complete installation, pass `--apply --start` with the same inputs.
Update an installed executable atomically and restart only the WWX runner.
Retain previous runtime files for recovery; do not clear the guest home.

## macOS compatibility patches

`runtime-patches/apply.sh` bounds the five dynamic loopback call sites, keeps
Codex engine sockets under the guest's TMPDIR, and uses Darwin libproc/sysctl
queries for process identity, argv and descendant discovery. System `ps` is
setuid on this macOS and cannot execute in Seatbelt. Native generation markers
are checked across argv reads to avoid PID reuse. Owner processes are excluded
by UID and the sandbox's same-sandbox process/signal rules. No system binary,
AMFI, TCC or system security setting is modified.

Port reservations use a fresh-lock grace and serialized stale cleanup. A crash
while holding a `.reap` guard conservatively leaves that port unavailable;
inspect the guest PID/locks before clearing that generated guard.

## Verification on 2026-10-27 CST

- 48 installed-layout/functional checks passed, zero failed.
- 11 allocator tests passed, including concurrent stale cleanup; four native
  process tests passed inside the real guest sandbox, including owner denial.
- Six tenant API tests and Hub typecheck/compilation passed. Proxy-environment
  tests passed with an unreachable external proxy and explicit loopback bypass.
- Public WWX code created Claude and Codex sessions; both returned the exact
  requested sentinel through their stated models. Public SSE delivered a frame.
- Public archive/stop succeeded after native process discovery was repaired.
  Test sessions were archived while retaining messages. Four inactive failed
  preallocation stubs return 409 on archive and remain as diagnostic history.
- Owner machine stayed online; owner desktop API 200, WWX 403, tampered code 401.
- Full CLI typecheck reports a pre-existing `nativeDesktop/codexIpc.ts:45`
  string/Buffer mismatch; that file is unchanged. No new patched-file errors.

Guest web terminal Socket.IO is not routed by the core API proxy. Chat,
creation, SSE and stop/archive were validated; terminal support is not claimed.

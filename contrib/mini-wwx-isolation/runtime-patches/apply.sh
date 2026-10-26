#!/bin/sh
# Apply the WWX bounded-guest-port patch to a HAPI CLI source tree.
#
# Usage: apply.sh /path/to/hapi/cli
#
# The source tree is modified in place. Re-running is refused (detects the
# guestPort import) so a stale half-patched tree cannot be built silently.
set -eu
umask 022

SRC=${1:?usage: apply.sh /path/to/hapi/cli}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

[ -f "$SRC/package.json" ] || { echo "apply.sh: not a HAPI CLI tree: $SRC" >&2; exit 66; }
grep -q '"name": "@twsxtd/hapi"' "$SRC/package.json" || { echo "apply.sh: unexpected package name" >&2; exit 66; }
[ -f "$SRC/src/runner/controlServer.ts" ] || { echo "apply.sh: missing controlServer.ts" >&2; exit 66; }
[ -f "$SRC/src/claude/utils/startHappyServer.ts" ] || { echo "apply.sh: missing startHappyServer.ts" >&2; exit 66; }
[ -f "$SRC/src/claude/utils/startHookServer.ts" ] || { echo "apply.sh: missing startHookServer.ts" >&2; exit 66; }
[ -f "$SRC/src/codex/shared/runtime.ts" ] || { echo "apply.sh: missing runtime.ts" >&2; exit 66; }
[ -f "$SRC/src/codex/shared/gateway.ts" ] || { echo "apply.sh: missing gateway.ts" >&2; exit 66; }

if grep -Rq "utils/guestPort" "$SRC/src/runner/controlServer.ts" "$SRC/src/claude/utils/startHappyServer.ts" \
    "$SRC/src/claude/utils/startHookServer.ts" "$SRC/src/codex/shared/runtime.ts" "$SRC/src/codex/shared/gateway.ts"; then
    echo "apply.sh: tree already patched; build from a clean checkout" >&2
    exit 65
fi

cp "$HERE/src/utils/guestPort.ts" "$SRC/src/utils/guestPort.ts"

# 0) Behavioral provenance probe. Bun compiled binaries do not reliably expose
#    string constants to `grep -a`, so the patched entrypoint answers a dedicated
#    flag before starting the CLI. An unpatched binary fails this probe.
[ -f "$SRC/src/index.ts" ] || { echo "apply.sh: missing src/index.ts" >&2; exit 66; }
perl -0pi -e 's/\A((?:#![^\n]*\n)?)/$1import { HAPI_GUEST_PORTS_V1 } from \x27\@\/utils\/guestPort\x27;\nif (process.argv.includes(\x27--guest-port-probe\x27)) { console.log(HAPI_GUEST_PORTS_V1); process.exit(0); }\n/' \
    "$SRC/src/index.ts"

# 1) Runner control server: explicit env port, bounded allocator fallback.
perl -0pi -e 's/\A((?:#![^\n]*\n)?)/$1import { reserveGuestPort } from \x27\@\/utils\/guestPort\x27;\n/' \
    "$SRC/src/runner/controlServer.ts"
perl -0pi -e "s/app\.listen\(\{ port: 0, host: '127\.0\.0\.1' \}/const guestPort = reserveGuestPort('runner-control', Number(process.env.HAPI_RUNNER_CONTROL_PORT) || 0);\n    app.listen({ port: guestPort, host: '127.0.0.1' }/" \
    "$SRC/src/runner/controlServer.ts"

# 2) Claude MCP HTTP bridge (its URL is persisted to the hub metadata).
perl -0pi -e 's/\A((?:#![^\n]*\n)?)/$1import { reserveGuestPort } from \x27\@\/utils\/guestPort\x27;\n/' \
    "$SRC/src/claude/utils/startHappyServer.ts"
perl -0pi -e 's/server\.listen\(0, "127\.0\.0\.1"/server.listen(reserveGuestPort(\x27claude-mcp\x27), "127.0.0.1"/' \
    "$SRC/src/claude/utils/startHappyServer.ts"

# 3) Claude permission hook server.
perl -0pi -e 's/\A((?:#![^\n]*\n)?)/$1import { reserveGuestPort } from \x27\@\/utils\/guestPort\x27;\n/' \
    "$SRC/src/claude/utils/startHookServer.ts"
perl -0pi -e "s/server\.listen\(0, '127\.0\.0\.1'/server.listen(reserveGuestPort('claude-hook'), '127.0.0.1'/" \
    "$SRC/src/claude/utils/startHookServer.ts"

# 4) Codex shared engine port probe: reserve inside the pool, keep legacy
#    fallback when HAPI_GUEST_PORT_MIN is unset.
perl -0pi -e 's/\A((?:#![^\n]*\n)?)/$1import { reserveGuestPort } from \x27\@\/utils\/guestPort\x27;\n/' \
    "$SRC/src/codex/shared/runtime.ts"
perl -0pi -e 's/async function freePort\(\): Promise<number> \{/async function freePort(): Promise<number> {\n    const guest = reserveGuestPort(\x27codex-engine\x27);\n    if (guest !== 0) return guest;/' \
    "$SRC/src/codex/shared/runtime.ts"

# 5) Codex frontend gateway websocket.
perl -0pi -e 's/\A((?:#![^\n]*\n)?)/$1import { reserveGuestPort } from \x27\@\/utils\/guestPort\x27;\n/' \
    "$SRC/src/codex/shared/gateway.ts"
perl -0pi -e "s/server\.listen\(0, '127\.0\.0\.1', resolve\)/server.listen(reserveGuestPort('codex-gateway'), '127.0.0.1', resolve)/" \
    "$SRC/src/codex/shared/gateway.ts"

BUN=${BUN:-/Users/zhuhe/.local/lib/hapi-mini/bin/bun}
"$BUN" "$HERE/patch-process.mjs" "$SRC"

sh "$HERE/check-patches.sh" "$SRC"
echo "apply.sh: OK (HAPI_GUEST_PORTS_V1 behavioral probe)"

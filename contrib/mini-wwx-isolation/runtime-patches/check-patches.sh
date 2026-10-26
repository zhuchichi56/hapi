#!/bin/sh
# Verify that every dynamic-loopback call site was rewritten to the bounded
# allocator. Usage: check-patches.sh /path/to/hapi/cli
set -eu

SRC=${1:?usage: check-patches.sh /path/to/hapi/cli}
fail=0
need() {
    file=$1
    pattern=$2
    if ! grep -q -- "$pattern" "$SRC/$file"; then
        echo "MISSING: $file <- $pattern" >&2
        fail=1
    fi
}

need src/runner/controlServer.ts "reserveGuestPort('runner-control'"
need src/claude/utils/startHappyServer.ts "reserveGuestPort('claude-mcp'"
need src/claude/utils/startHookServer.ts "reserveGuestPort('claude-hook'"
need src/codex/shared/runtime.ts "reserveGuestPort('codex-engine'"
need src/codex/shared/gateway.ts "reserveGuestPort('codex-gateway'"
need src/index.ts "--guest-port-probe"
need src/index.ts "HAPI_GUEST_PORTS_V1"

if [ "$fail" -ne 0 ]; then
    exit 1
fi
echo "check-patches.sh: all 5 bounded-port call sites + behavioral probe present"

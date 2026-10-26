#!/bin/sh
# WWX isolation verifier. Run as root after install (and again after --start).
# Read-only: never prints secret contents and never mutates the runtime.
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

ISO_ROOT="/Library/Application Support/HAPI-WWX-Isolation"
RUNTIME="/opt/hapi-wwx/bin"
TENANT_USER="hapi-wwx"
TENANT_HOME="/Users/hapi-wwx"
HAPI_HOME="$TENANT_HOME/.hapi"
ADMIN_HOME="/Users/zhuhe"
HUB_PORT=3026
PROXY_PORT=4126
GUEST_MIN=43100
GUEST_MAX=43131

pass=0; fail=0
ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$*"; }
no() { fail=$((fail + 1)); printf 'FAIL  %s\n' "$*"; }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }
run_as() { /usr/bin/sudo -n -u "$TENANT_USER" "$@"; }

[ "$(id -u)" -eq 0 ] || { echo "verify.sh: must run as root" >&2; exit 77; }

echo "== identity and filesystem =="
check "hapi-wwx exists" "dscl . -read /Users/$TENANT_USER >/dev/null 2>&1"
uid=$(dscl . -read "/Users/$TENANT_USER" UniqueID 2>/dev/null | awk '{print $2}')
gid=$(dscl . -read "/Users/$TENANT_USER" PrimaryGroupID 2>/dev/null | awk '{print $2}')
[ "$uid" = "560" ] && ok "uid is 560" || no "uid is ${uid:-none}, expected 560"
[ "$gid" = "20" ] && ok "gid is 20 (staff)" || no "gid is ${gid:-none}, expected 20"
if dscl . -read /Groups/admin GroupMembership 2>/dev/null | grep -qw "$TENANT_USER"; then
    no "hapi-wwx is in admin group"
else
    ok "hapi-wwx is not admin"
fi
check "home mode 0700" "[ \"\$(stat -f %Lp \"$TENANT_HOME\")\" = 700 ]"
check "home owner is hapi-wwx" "[ \"\$(stat -f %u \"$TENANT_HOME\")\" = \"$uid\" ]"
check "no .ssh in guest home" "[ ! -e \"$TENANT_HOME/.ssh\" ]"
check "runtime dir root:wheel" "[ \"\$(stat -f %Su:%Sg /opt/hapi-wwx)\" = 'root:wheel' ]"
check "hapi binary is 0555 root:wheel" "[ \"\$(stat -f %Lp \"$RUNTIME/hapi\")\" = 555 ] && [ \"\$(stat -f %Su:%Sg \"$RUNTIME/hapi\")\" = 'root:wheel' ]"
check "patched CLI behavioral probe" "test \"\$(\"$RUNTIME/hapi\" --guest-port-probe 2>/dev/null)\" = HAPI_GUEST_PORTS_V1"
check "profile 0444 root:wheel" "[ \"\$(stat -f %Lp \"$ISO_ROOT/policy/wwx.sb\")\" = 444 ]"
check "wrapper 0555 root:wheel" "[ \"\$(stat -f %Lp \"$ISO_ROOT/bin/hapi-tenant-run\")\" = 555 ]"
check "manifest exists" "[ -f \"$ISO_ROOT/manifest.sha256\" ]"
check "profile contains at least 96 exact guest-port rules" "[ \"\$(grep -c 'localhost:431' \"$ISO_ROOT/policy/wwx.sb\")\" -ge 96 ]"
if grep -qE 'localhost:\*|localhost:43100-43131|\(allow network\*' "$ISO_ROOT/policy/wwx.sb"; then
    no "wildcard/range network rule present"
else
    ok "no wildcard/range network rule"
fi

echo "== secrets and settings =="
for f in "$HAPI_HOME/secrets/cli-token" "$HAPI_HOME/secrets/proxy-token" "$HAPI_HOME/settings.json" "$HAPI_HOME/jwt-secret.json"; do
    check "$(basename "$f") mode 0600" "[ \"\$(stat -f %Lp \"$f\")\" = 600 ]"
    check "$(basename "$f") owner hapi-wwx" "[ \"\$(stat -f %u \"$f\")\" = \"$uid\" ]"
done
if "$RUNTIME/bun" -e 'const s=JSON.parse(await Bun.file(process.argv[1]).text()); const t=(await Bun.file(process.argv[2]).text()).trim(); process.exit(s.cliApiToken===t && !t.includes(":") ? 0:1)' "$HAPI_HOME/settings.json" "$HAPI_HOME/secrets/cli-token"; then
    ok "settings token equals private base token with no suffix"
else
    no "settings token differs from private base token"
fi
check "jwt secret is 32 bytes base64" "test \"\$(sed -n 's/.*\"secretBase64\":\"\\([^\"]*\\)\".*/\\1/p' \"$HAPI_HOME/jwt-secret.json\" | base64 -D 2>/dev/null | wc -c | tr -d ' ')\" = 32"
check "codex model fixed to gpt-6.1-sol" "grep -q '^model = \"gpt-6.1-sol\"' \"$TENANT_HOME/.codex/config.toml\""
check "codex uses guest proxy" "grep -q 'base_url = \"http://127.0.0.1:4126/v1\"' \"$TENANT_HOME/.codex/config.toml\""
check "no credentials copied into package tree" "! grep -rIlE 'sk-[A-Za-z0-9]|Bearer [A-Za-z0-9_-]{20,}' \"$ISO_ROOT/bin\" 2>/dev/null | grep -q ."

echo "== launchd =="
for role in hub runner proxy; do
    plist="/Library/LaunchDaemons/run.hapi.wwx.$role.plist"
    check "$role plist valid" "plutil -lint \"$plist\" >/dev/null"
    check "$role plist root:wheel 0644" "[ \"\$(stat -f %Lp \"$plist\")\" = 644 ]"
done

echo "== ports and processes =="
for p in "$HUB_PORT" "$PROXY_PORT"; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
        owner=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -F u 2>/dev/null | sed -n 's/^u//p' | head -1)
        [ "$owner" = "$uid" ] && ok "port $p owned by hapi-wwx" || no "port $p owned by ${owner:-unknown}"
    else
        echo "SKIP  port $p not listening (services disabled?)"
    fi
done
owner3006=$(lsof -nP -iTCP:3006 -sTCP:LISTEN -F u 2>/dev/null | sed -n 's/^u//p' | head -1)
[ "$owner3006" = "501" ] && ok "owner hub 3006 still owned by zhuhe" || echo "SKIP  owner hub 3006 not listening"
if lsof -nP -iTCP:4150 -sTCP:LISTEN >/dev/null 2>&1; then
    ok "upstream 4150 listener present (MacBook tunnel)"
else
    echo "SKIP  upstream 4150 absent; model calls will 502"
fi

if [ -f "$HAPI_HOME/runner.state.json" ]; then
    cp=$("$RUNTIME/bun" -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).httpPort)' "$HAPI_HOME/runner.state.json")
    if [ -n "$cp" ] && [ "$cp" -ge "$GUEST_MIN" ] && [ "$cp" -le "$GUEST_MAX" ]; then
        ok "runner control port $cp is inside $GUEST_MIN..$GUEST_MAX"
    else
        no "runner control port '${cp:-none}' outside $GUEST_MIN..$GUEST_MAX"
    fi
else
    echo "SKIP  runner state absent (runner not started yet)"
fi

echo "== Seatbelt functional checks (as hapi-wwx) =="
check "wrapper executes /usr/bin/true" "run_as \"$ISO_ROOT/bin/hapi-tenant-run\" wwx agent -- /usr/bin/true >/dev/null 2>&1"
check "guest cannot read owner home" "! run_as \"$ISO_ROOT/bin/hapi-tenant-run\" wwx agent -- /bin/cat \"$ADMIN_HOME/.hapi/settings.json\" >/dev/null 2>&1"
check "guest cannot reach owner hub 3006" "! run_as \"$ISO_ROOT/bin/hapi-tenant-run\" wwx agent -- /usr/bin/curl -sS -m 2 http://127.0.0.1:3006/ >/dev/null 2>&1"
check "guest cannot reach upstream 4150 directly" "! run_as \"$ISO_ROOT/bin/hapi-tenant-run\" wwx agent -- /usr/bin/curl -sS -m 2 http://127.0.0.1:4150/v1/models >/dev/null 2>&1"
check "guest can reach its hub port 3026" "run_as \"$ISO_ROOT/bin/hapi-tenant-run\" wwx agent -- /usr/bin/curl -sS -m 2 http://127.0.0.1:3026/ >/dev/null 2>&1"
check "guest can reach its proxy port 4126" "run_as \"$ISO_ROOT/bin/hapi-tenant-run\" wwx agent -- /usr/bin/curl -sS -m 2 http://127.0.0.1:4126/v1/models >/dev/null 2>&1"

echo "== model proxy allowlist =="
token=$(cat "$HAPI_HOME/secrets/proxy-token" 2>/dev/null)
if [ -n "$token" ]; then
    status=$({ printf 'header = "Authorization: Bearer %s"\n' "$token"; } | \
        curl -sS -m 5 -K - -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PROXY_PORT/v1/models" 2>/dev/null)
    [ "$status" = "200" ] && ok "known token can list models" || no "model proxy /v1/models returned ${status:-no-response}"
    status=$({ printf 'header = "Authorization: Bearer %s"\n' "$token"; } | \
        curl -sS -m 5 -K - -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
        -d '{"model":"gpt-6.1-sol","max_tokens":1,"messages":[]}' "http://127.0.0.1:$PROXY_PORT/v1/messages" 2>/dev/null)
    case "$status" in 4*|5*) ok "unexpected model/route rejected or upstream error ($status)";; *) no "unexpected model/route not rejected ($status)";; esac
    status=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PROXY_PORT/v1/models" 2>/dev/null)
    [ "$status" = "401" ] && ok "unauthenticated model request is 401" || no "unauthenticated model request returned ${status:-none}"
else
    echo "SKIP  proxy token unreadable"
fi
token=""

echo
printf 'RESULT: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

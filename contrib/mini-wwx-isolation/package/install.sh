#!/bin/sh
# WWX-only administrator bootstrap installer for the mini.
#
# SAFETY MODEL
#   - root only; dry-run by default; --apply required to change the machine
#   - fail closed on any conflict; never adopts a partial/foreign layout
#   - no sudoers/SSH/firewall changes; owner hub 3006 and owner runtime untouched
#   - generates CLI/proxy/JWT secrets, never prints or logs them
#   - services stay disabled unless --start is explicit
#
# Installs: hapi-wwx OS account (UID 560, not admin), /opt/hapi-wwx root-owned
# runtime (must be the patched HAPI_GUEST_PORTS_V1 binary), root-owned isolation
# profile/wrapper, tenant home, model proxy and three LaunchDaemons.
set -eu
umask 077

PKG_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

ISO_ROOT="/Library/Application Support/HAPI-WWX-Isolation"
RUNTIME="/opt/hapi-wwx/bin"
ADMIN_HOME="/Users/zhuhe"
ADMIN_USER="zhuhe"
SOURCE_RUNNER="/Users/zhuhe/.local/lib/hapi-runner/bin"
SOURCE_BUN="/Users/zhuhe/.local/lib/hapi-mini/bin/bun"
UPSTREAM_URL="http://127.0.0.1:4150"
TENANT="wwx"
TENANT_USER="hapi-wwx"
TENANT_HOME="/Users/$TENANT_USER"
WWX_UID=560
HUB_PORT=3026
PROXY_PORT=4126
GUEST_PORT_MIN=43100
GUEST_PORT_MAX=43131
RUNTIME_BINS="codex rg codex-code-mode-host"
CLI_SOURCE="${WWX_CLI_BIN:-$PKG_DIR/runtime/hapi}"
CLAUDE_SOURCE="${WWX_CLAUDE_BIN:-}"

APPLY=0
START=0
for arg in "$@"; do
    case "$arg" in
        --apply) APPLY=1 ;;
        --start) START=1 ;;
        --dry-run) APPLY=0 ;;
        -h|--help)
            cat <<'EOF'
Usage: sudo ./install.sh [--dry-run|--apply] [--start]

  --dry-run   (default) print actions, change nothing
  --apply     create the hapi-wwx account, runtime, secrets, policies, plists
  --start     with --apply, bootstrap the WWX LaunchDaemons (default disabled)

The CLI binary must be a patched build containing HAPI_GUEST_PORTS_V1.
Pass WWX_CLI_BIN=/path/to/patched/hapi, or place it at package/runtime/hapi.
EOF
            exit 0
            ;;
        *) echo "install.sh: unknown argument: $arg" >&2; exit 64 ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "install.sh: must run as root (sudo ./install.sh)" >&2
    exit 77
fi
if [ "$(uname -s)" != "Darwin" ]; then
    echo "install.sh: this package targets macOS only" >&2
    exit 69
fi
if [ "$START" -eq 1 ] && [ "$APPLY" -ne 1 ]; then
    echo "install.sh: --start requires --apply" >&2
    exit 64
fi

log() { printf '%s\n' "== $*"; }
note() { printf '%s\n' "   $*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
act() {
    if [ "$APPLY" -eq 1 ]; then "$@"; else printf '[dry-run] %s\n' "$*"; fi
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
log "preflight"
for tool in dscl sysadminctl plutil launchctl lsof install shasum awk sed curl grep perl; do
    command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
[ -x /usr/bin/sandbox-exec ] || die "missing /usr/bin/sandbox-exec"
[ -d "$ADMIN_HOME" ] || die "admin home not found: $ADMIN_HOME"
[ -x "$SOURCE_BUN" ] || die "known bun binary not found: $SOURCE_BUN"
for b in $RUNTIME_BINS; do
    [ -x "$SOURCE_RUNNER/$b" ] || die "known mini binary not found: $SOURCE_RUNNER/$b"
done
for f in templates/tenant.sb.template templates/hapi-tenant-run model-proxy.ts verify.sh; do
    [ -e "$PKG_DIR/$f" ] || die "package file missing: $f"
done
[ -f "$CLI_SOURCE" ] || die "patched CLI binary not found: $CLI_SOURCE (set WWX_CLI_BIN)"
# Opt-in provenance: build.sh writes hapi.sha256 next to the binary. If present,
# require an exact match before executing it.
if [ -f "$CLI_SOURCE.sha256" ]; then
    expected_sha=$(awk '{print $1}' "$CLI_SOURCE.sha256")
    actual_sha=$(shasum -a 256 "$CLI_SOURCE" | awk '{print $1}')
    [ "$expected_sha" = "$actual_sha" ] \
        || die "CLI sha256 does not match $CLI_SOURCE.sha256"
fi
# Bun compiled binaries do not reliably expose string constants to grep, so
# provenance is behavioral: the patched entrypoint answers this flag before
# starting the CLI. Timeout guards an unpatched binary that might wait on stdin.
probe=$(
    perl -e 'alarm 20; exec @ARGV' "$CLI_SOURCE" --guest-port-probe </dev/null 2>/dev/null || true
)
[ "$probe" = "HAPI_GUEST_PORTS_V1" ] \
    || die "CLI failed the HAPI_GUEST_PORTS_V1 behavioral probe; refusing unpatched build"

conflicts=0
if dscl . -read "/Users/$TENANT_USER" >/dev/null 2>&1; then
    conflicts=$((conflicts + 1)); note "conflict: user already exists: $TENANT_USER"
fi
if [ -e "$TENANT_HOME" ]; then
    conflicts=$((conflicts + 1)); note "conflict: home path already exists: $TENANT_HOME"
fi
for path in /opt/hapi-wwx "$ISO_ROOT"; do
    if [ -e "$path" ]; then
        conflicts=$((conflicts + 1)); note "conflict: path already exists: $path"
    fi
done
for f in /Library/LaunchDaemons/run.hapi.wwx.*.plist; do
    if [ -e "$f" ]; then
        conflicts=$((conflicts + 1)); note "conflict: LaunchDaemon already exists: $f"
    fi
done

if [ "$conflicts" -gt 0 ]; then
    complete=1
    [ -d "$ISO_ROOT" ] || complete=0
    [ -d "/opt/hapi-wwx" ] || complete=0
    [ -f "$ISO_ROOT/STATUS.json" ] || complete=0
    dscl . -read "/Users/$TENANT_USER" >/dev/null 2>&1 || complete=0
    for role in hub runner proxy; do
        [ -f "/Library/LaunchDaemons/run.hapi.wwx.$role.plist" ] || complete=0
    done
    if [ "$complete" -eq 1 ] && [ "$START" -eq 1 ]; then
        log "already installed: starting WWX services only (--start)"
        for role in proxy hub runner; do
            label="run.hapi.wwx.$role"
            plist="/Library/LaunchDaemons/$label.plist"
            launchctl bootstrap system "$plist" >/dev/null 2>&1 || true
            launchctl enable "system/$label" >/dev/null 2>&1 || true
            launchctl kickstart -k "system/$label" >/dev/null 2>&1 || true
        done
        note "bootstrap requested; run verify.sh to confirm"
        exit 0
    fi
    die "partial or foreign WWX layout detected; refusing to touch anything"
fi

[ -n "$CLAUDE_SOURCE" ] && [ -f "$CLAUDE_SOURCE" ] || die "WWX_CLAUDE_BIN must name the native Claude executable"

# Private loopback pool must be completely free before install.
port=43100
while [ "$port" -le 43131 ]; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        die "guest private port $port is already in use"
    fi
    port=$((port + 1))
done
for p in "$HUB_PORT" "$PROXY_PORT"; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
        die "port $p is already in use"
    fi
done
if ! lsof -nP -iTCP:4150 -sTCP:LISTEN >/dev/null 2>&1; then
    note "warning: no listener on 127.0.0.1:4150; proxy returns 502 until the MacBook tunnel is up"
fi
if dscl . -list /Users UniqueID 2>/dev/null | awk '{print $2}' | grep -qx "$WWX_UID"; then
    die "UID $WWX_UID is already in use; refusing to pick a different identity silently"
fi
ADMIN_MODE=$(stat -f '%Lp' "$ADMIN_HOME" 2>/dev/null || echo unknown)
note "admin home mode: $ADMIN_MODE (package does not modify it; profile denies it)"
note "plan: hapi-wwx uid $WWX_UID, home 0700, hub $HUB_PORT, proxy $PROXY_PORT, private ports $GUEST_PORT_MIN..$GUEST_PORT_MAX"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
gen_token() { dd if=/dev/urandom bs=32 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'; }
gen_b64() { dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\n'; }
gen_password() { dd if=/dev/urandom bs=24 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'; }

build_port_rules() {
    p=$GUEST_PORT_MIN
    while [ "$p" -le "$GUEST_PORT_MAX" ]; do
        printf '(allow network-bind (local ip "localhost:%s"))\n' "$p"
        printf '(allow network-inbound (local ip "localhost:%s"))\n' "$p"
        printf '(allow network-outbound (remote ip "localhost:%s"))\n' "$p"
        p=$((p + 1))
    done
}

render_profile() {
    rules_file=$(mktemp /tmp/hapi-wwx-rules.XXXXXX)
    build_port_rules > "$rules_file"
    sed \
        -e "s|@ADMIN_HOME@|$ADMIN_HOME|g" \
        -e "s|@ADMIN_USER@|$ADMIN_USER|g" \
        -e "s|@TENANT_HOME@|$TENANT_HOME|g" \
        -e "s|@HUB_PORT@|$HUB_PORT|g" \
        -e "s|@PROXY_PORT@|$PROXY_PORT|g" \
        -e "s|@GUEST_PORT_MIN@|$GUEST_PORT_MIN|g" \
        -e "s|@GUEST_PORT_MAX@|$GUEST_PORT_MAX|g" \
        "$PKG_DIR/templates/tenant.sb.template" \
    | awk -v rules_file="$rules_file" '{ if ($0 == "@GUEST_PORT_RULES@") { while ((getline rule < rules_file) > 0) print rule; close(rules_file) } else print }'
    rm -f "$rules_file"
}

plist_header() {
    label=$1; user=$2; wd=$3; logdir=$4
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>UserName</key><string>$user</string>
    <key>GroupName</key><string>staff</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>ProcessType</key><string>Background</string>
    <key>WorkingDirectory</key><string>$wd</string>
    <key>StandardOutPath</key><string>$logdir/$label.out.log</string>
    <key>StandardErrorPath</key><string>$logdir/$label.err.log</string>
    <key>ProgramArguments</key>
    <array>
EOF
}

write_hub_plist() {
    plist_header "run.hapi.wwx.hub" "$TENANT_USER" "$TENANT_HOME" "$TENANT_HOME/.hapi/logs"
    cat <<EOF
        <string>$ISO_ROOT/bin/hapi-tenant-run</string>
        <string>wwx</string><string>hub</string><string>--</string>
        <string>$RUNTIME/hapi</string><string>hub</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HAPI_TENANT</key><string>wwx</string>
        <key>HAPI_HOME</key><string>$TENANT_HOME/.hapi</string>
    </dict>
</dict>
</plist>
EOF
}

write_runner_plist() {
    plist_header "run.hapi.wwx.runner" "$TENANT_USER" "$TENANT_HOME/work" "$TENANT_HOME/.hapi/logs"
    cat <<EOF
        <string>$ISO_ROOT/bin/hapi-tenant-run</string>
        <string>wwx</string><string>runner</string><string>--</string>
        <string>$RUNTIME/hapi</string><string>runner</string><string>start-sync</string>
        <string>--workspace-root</string><string>$TENANT_HOME/work</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HAPI_TENANT</key><string>wwx</string>
        <key>HAPI_HOME</key><string>$TENANT_HOME/.hapi</string>
    </dict>
</dict>
</plist>
EOF
}

write_proxy_plist() {
    plist_header "run.hapi.wwx.proxy" "$TENANT_USER" "/" "$TENANT_HOME/.hapi/logs"
    cat <<EOF
        <string>$RUNTIME/bun</string>
        <string>$ISO_ROOT/bin/model-proxy.ts</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HAPI_TENANT</key><string>wwx</string>
        <key>PROXY_PORT</key><string>$PROXY_PORT</string>
        <key>UPSTREAM_URL</key><string>$UPSTREAM_URL</string>
        <key>TOKEN_FILE</key><string>$TENANT_HOME/.hapi/secrets/proxy-token</string>
        <key>LOG_PREFIX</key><string>model-proxy-wwx</string>
        <key>HOME</key><string>$TENANT_HOME</string>
        <key>TMPDIR</key><string>$TENANT_HOME/.hapi/tmp</string>
    </dict>
</dict>
</plist>
EOF
}

# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------
log "install plan (apply=$APPLY start=$START)"

# 1) root-owned runtime
act install -d -o root -g wheel -m 0755 /opt/hapi-wwx "$RUNTIME"
act install -o root -g wheel -m 0555 "$CLI_SOURCE" "$RUNTIME/hapi"
for b in $RUNTIME_BINS; do
    act install -o root -g wheel -m 0555 "$SOURCE_RUNNER/$b" "$RUNTIME/$b"
done
act install -o root -g wheel -m 0555 "$SOURCE_BUN" "$RUNTIME/bun"
act install -o root -g wheel -m 0555 "$CLAUDE_SOURCE" "$RUNTIME/claude"


# 2) root-owned isolation tree
act install -d -o root -g wheel -m 0755 "$ISO_ROOT" "$ISO_ROOT/bin" "$ISO_ROOT/policy"
act install -o root -g wheel -m 0555 "$PKG_DIR/templates/hapi-tenant-run" "$ISO_ROOT/bin/hapi-tenant-run"
act install -o root -g wheel -m 0444 "$PKG_DIR/model-proxy.ts" "$ISO_ROOT/bin/model-proxy.ts"

# 3) OS account (random password passed once, never printed)
if [ "$APPLY" -eq 1 ]; then
    password=$(gen_password)
    if ! sysadminctl -addUser "$TENANT_USER" -fullName "HAPI WWX" -UID "$WWX_UID" -GID 20 \
         -shell /bin/zsh -home "$TENANT_HOME" -password "$password" >/dev/null 2>&1; then
        password=""
        die "sysadminctl failed for $TENANT_USER"
    fi
    password=""
    dscl . -create "/Users/$TENANT_USER" PrimaryGroupID 20 2>/dev/null || true
    dscl . -create "/Users/$TENANT_USER" NFSHomeDirectory "$TENANT_HOME" 2>/dev/null || true
    actual_uid=$(dscl . -read "/Users/$TENANT_USER" UniqueID 2>/dev/null | awk '{print $2}')
    actual_gid=$(dscl . -read "/Users/$TENANT_USER" PrimaryGroupID 2>/dev/null | awk '{print $2}')
    [ "$actual_uid" = "$WWX_UID" ] || die "created $TENANT_USER with unexpected uid ${actual_uid:-none}"
    [ "$actual_gid" = "20" ] || die "created $TENANT_USER with unexpected gid ${actual_gid:-none}"
    if dscl . -read /Groups/admin GroupMembership 2>/dev/null | grep -qw "$TENANT_USER"; then
        die "created $TENANT_USER is unexpectedly in the admin group"
    fi
else
    printf '[dry-run] sysadminctl -addUser %s -UID %s -home %s -password <random, not printed>\n' \
        "$TENANT_USER" "$WWX_UID" "$TENANT_HOME"
fi

act install -d -o "$TENANT_USER" -g staff -m 0700 "$TENANT_HOME"
act chown "$TENANT_USER":staff "$TENANT_HOME"
act chmod 700 "$TENANT_HOME"
act install -d -o "$TENANT_USER" -g staff -m 0700 \
    "$TENANT_HOME/.hapi" "$TENANT_HOME/.hapi/logs" "$TENANT_HOME/.hapi/secrets" \
    "$TENANT_HOME/.hapi/tmp" "$TENANT_HOME/work" "$TENANT_HOME/.codex"

act install -d -o "$TENANT_USER" -g staff -m 0700 /private/tmp/claude-560 /private/tmp/codex-daemon-560

# 4) per-tenant secrets, 0600, contents never printed
if [ "$APPLY" -eq 1 ]; then
    cli_token=$(gen_token)
    proxy_token=$(gen_token)
    jwt_secret=$(gen_b64)
    printf '%s\n' "$cli_token" > "$TENANT_HOME/.hapi/secrets/cli-token"
    printf '%s\n' "$proxy_token" > "$TENANT_HOME/.hapi/secrets/proxy-token"
    printf '{"cliApiToken":"%s"}\n' "$cli_token" > "$TENANT_HOME/.hapi/settings.json"
    printf '{"secretBase64":"%s"}\n' "$jwt_secret" > "$TENANT_HOME/.hapi/jwt-secret.json"
    chown "$TENANT_USER":staff \
        "$TENANT_HOME/.hapi/secrets/cli-token" "$TENANT_HOME/.hapi/secrets/proxy-token" \
        "$TENANT_HOME/.hapi/settings.json" "$TENANT_HOME/.hapi/jwt-secret.json"
    chmod 600 \
        "$TENANT_HOME/.hapi/secrets/cli-token" "$TENANT_HOME/.hapi/secrets/proxy-token" \
        "$TENANT_HOME/.hapi/settings.json" "$TENANT_HOME/.hapi/jwt-secret.json"
    cli_token=""; proxy_token=""; jwt_secret=""
    note "generated cli-token, proxy-token, jwt-secret (0600, contents not printed)"
else
    printf '[dry-run] generate 0600 cli-token, proxy-token, jwt-secret in %s\n' "$TENANT_HOME/.hapi"
fi

# 5) Codex points only at the guest proxy; fixed model.
if [ "$APPLY" -eq 1 ]; then
    cat > "$TENANT_HOME/.codex/config.toml" <<EOF
model = "gpt-6.1-sol"
model_provider = "hapi-wwx"

[model_providers.hapi-wwx]
name = "HAPI WWX guest"
base_url = "http://127.0.0.1:$PROXY_PORT/v1"
env_key = "HAPI_GUEST_MODEL_TOKEN"
wire_api = "responses"
EOF
    chown "$TENANT_USER":staff "$TENANT_HOME/.codex/config.toml"
    chmod 600 "$TENANT_HOME/.codex/config.toml"
else
    printf '[dry-run] write %s/.codex/config.toml (gpt-6.1-sol via proxy %s)\n' "$TENANT_HOME" "$PROXY_PORT"
fi

# 6) rendered Seatbelt profile
tmp_profile=$(mktemp /tmp/hapi-wwx-profile.XXXXXX)
render_profile > "$tmp_profile"
if grep -q '@[A-Z_]*@' "$tmp_profile"; then
    rm -f "$tmp_profile"
    die "unrendered placeholder in WWX profile"
fi
act install -o root -g wheel -m 0444 "$tmp_profile" "$ISO_ROOT/policy/wwx.sb"
rm -f "$tmp_profile"

# 7) LaunchDaemons (not bootstrapped unless --start)
for role in hub runner proxy; do
    tmp_plist=$(mktemp /tmp/hapi-wwx-plist.XXXXXX)
    case "$role" in
        hub) write_hub_plist > "$tmp_plist" ;;
        runner) write_runner_plist > "$tmp_plist" ;;
        proxy) write_proxy_plist > "$tmp_plist" ;;
    esac
    plutil -lint "$tmp_plist" >/dev/null || die "invalid plist for wwx/$role"
    act install -o root -g wheel -m 0644 "$tmp_plist" "/Library/LaunchDaemons/run.hapi.wwx.$role.plist"
    rm -f "$tmp_plist"
done

# 8) manifest + status (no secrets)
if [ "$APPLY" -eq 1 ]; then
    manifest="$ISO_ROOT/manifest.sha256"
    : > "$manifest"
    for f in "$RUNTIME/hapi" "$RUNTIME/claude" "$RUNTIME/codex" "$RUNTIME/rg" "$RUNTIME/codex-code-mode-host" "$RUNTIME/bun" \
             "$ISO_ROOT/bin/hapi-tenant-run" "$ISO_ROOT/bin/model-proxy.ts" "$ISO_ROOT/policy/wwx.sb"; do
        shasum -a 256 "$f" >> "$manifest"
    done
    chown root:wheel "$manifest"; chmod 0444 "$manifest"
    services_state="disabled"
    [ "$START" -eq 1 ] && services_state="bootstrap_requested"
    cli_sha=$(shasum -a 256 "$RUNTIME/hapi" | awk '{print $1}')
    cat > "$ISO_ROOT/STATUS.json" <<EOF
{
  "schema": 1,
  "tenant": "wwx",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "services": "$services_state",
  "user": {"name": "hapi-wwx", "uid": $WWX_UID, "home": "$TENANT_HOME", "admin": false},
  "cli": {"path": "$RUNTIME/hapi", "sha256": "$cli_sha", "provenance_probe": "HAPI_GUEST_PORTS_V1"},
  "ports": {"hub": $HUB_PORT, "model_proxy": $PROXY_PORT, "guest_private": "$GUEST_PORT_MIN-$GUEST_PORT_MAX", "upstream": "127.0.0.1:4150"},
  "launchdaemons": ["run.hapi.wwx.proxy", "run.hapi.wwx.hub", "run.hapi.wwx.runner"],
  "open_items": [
    "services are disabled until the planner runs: sudo ./install.sh --apply --start",
    "CLI provenance is a behavioral --guest-port-probe check plus sha256 (Bun binaries do not expose plaintext markers)",
    "Claude CLI installed from explicitly supplied native executable; model reply still requires E2E verification",
    "Seatbelt mach/UNIX-socket needs are not proven for every Codex/Claude subcommand; verify.sh covers core paths"
  ]
}
EOF
    chown root:wheel "$ISO_ROOT/STATUS.json"; chmod 0644 "$ISO_ROOT/STATUS.json"
    note "wrote $ISO_ROOT/STATUS.json (services=$services_state)"
else
    printf '[dry-run] write %s/STATUS.json (services=disabled)\n' "$ISO_ROOT"
fi

# 9) optional explicit start: proxy first, then hub, then runner
if [ "$START" -eq 1 ] && [ "$APPLY" -eq 1 ]; then
    log "starting WWX services"
    for role in proxy hub runner; do
        label="run.hapi.wwx.$role"
        launchctl bootstrap system "/Library/LaunchDaemons/$label.plist" >/dev/null 2>&1 || true
        launchctl enable "system/$label" >/dev/null 2>&1 || true
        launchctl kickstart -k "system/$label" >/dev/null 2>&1 || true
        if [ "$role" = "hub" ]; then
            n=0
            while [ "$n" -lt 60 ]; do
                if lsof -nP -iTCP:"$HUB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
                sleep 1; n=$((n + 1))
            done
            lsof -nP -iTCP:"$HUB_PORT" -sTCP:LISTEN >/dev/null 2>&1 \
                || note "warning: hub $HUB_PORT not listening yet; check /Users/hapi-wwx/.hapi/logs"
        fi
    done
    note "bootstrap requested; run package/verify.sh to confirm"
fi

cat <<EOF

Next (planner):
  sudo $PKG_DIR/install.sh --dry-run
  sudo $PKG_DIR/install.sh --apply
  sudo $PKG_DIR/install.sh --apply --start
  sudo $PKG_DIR/verify.sh

Secrets are root/tenant 0600 under $TENANT_HOME/.hapi and were not printed.
Owner hub 3006, owner runtime and owner credentials were not touched.
EOF

#!/bin/sh
# Build the WWX-only patched HAPI CLI.
#
# Usage: build.sh /path/to/hapi/cli [/path/to/output-dir]
#
# Build this from a COPY of the CLI tree; apply.sh modifies the tree in place.
# Requires the Bun already present on the mini (1.4.2), node_modules and the
# repo's build tooling. It only builds the host target (bun-darwin-arm64).
set -eu
umask 022

SRC=${1:?usage: build.sh /path/to/hapi/cli [output-dir]}
OUT=${2:-$PWD/out}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUN=${BUN:-/Users/zhuhe/.local/lib/hapi-mini/bin/bun}

[ -x "$BUN" ] || { echo "build.sh: bun not found: $BUN (set BUN=)" >&2; exit 66; }
[ -d "$SRC/node_modules" ] || { echo "build.sh: $SRC/node_modules missing; cannot build offline" >&2; exit 66; }

sh "$HERE/apply.sh" "$SRC"
mkdir -p "$OUT"
chmod 755 "$OUT"

cd "$SRC"
# The all-in-one variant embeds the hub web assets into the executable.
"$BUN" run scripts/build-executable.ts --with-web-assets

built=""
# Actual build-executable.ts layout on the mini: <cli>/dist-exe/<target>/hapi.
for candidate in \
    "$SRC/dist-exe/bun-darwin-arm64/hapi" \
    "$SRC/dist-exe/bun-darwin-x64/hapi" \
    "$SRC/dist-exe/hapi-darwin-arm64"; do
    if [ -f "$candidate" ]; then built=$candidate; break; fi
done
[ -n "$built" ] || built=$(find "$SRC/dist-exe" -type f -name hapi -path '*darwin*' | head -1)
[ -n "$built" ] || { echo "build.sh: build produced no darwin binary under $SRC/dist-exe" >&2; exit 70; }

cp -f "$built" "$OUT/hapi"
chmod 0555 "$OUT/hapi"
# Bun compiled binaries hide constants from grep; use the behavioral probe.
if [ "$("$OUT/hapi" --guest-port-probe 2>/dev/null)" != "HAPI_GUEST_PORTS_V1" ]; then
    echo "build.sh: built binary failed the HAPI_GUEST_PORTS_V1 behavioral probe" >&2
    exit 70
fi
printf '%s\n' "$built" > "$OUT/hapi.build-source"
shasum -a 256 "$OUT/hapi" > "$OUT/hapi.sha256"
echo "build.sh: OK -> $OUT/hapi"
cat "$OUT/hapi.sha256"

# Consolidate historical WWX conversations

This package moves historical HAPI records into the existing Mini WWX backend,
machine and project. It does not create another project, namespace or database.
The public owner account receives an explicitly configured projection of that
backend; the WWX login remains scoped to WWX. Native Desktop routes stay local
and owner-only.

## Deployed result (2026-11-01)

- 143 historical records and all 267,653 saved messages imported. Message IDs,
  ordering, timestamps, TEXT/BLOB bytes and delivery fields match the snapshot.
  No historical message has an uninvoked queued state; old prompts were not replayed.
- 128 historical conversations have content; 15 empty historical stubs are retained.
  The public UI shows one WWX project, with 134 real conversations including the
  six pre-existing current conversations. Both login identities were checked.
- Nine native rollouts were recovered from original files. The other 119 native
  continuation contexts were reconstructed from saved HAPI messages, retaining
  the last bounded visible exchange and a reference to the full private archive.
  This is **not lossless recovery of the missing native files**. Previously
  truncated tool output and absent external Linux resources cannot be recreated.
  All 127 known native IDs are preserved; the one history without a native ID
  receives a recorded new ID.
- All 128 native histories passed actual installed Codex `thread/read` and
  `thread/resume` in an isolated profile, without model requests. One original
  and one reconstructed conversation then completed a real new model/tool turn
  through the public owner's API, preserving HAPI/native IDs. The two test
  histories were returned to their archived state. Existing model tasks and
  runners were not restarted; Hub listeners were restarted for cache/release updates.
- Source workspace copied without overwrites/deletion, and checksum comparison
  found no missing or differing original files before intentional relocations.
  Linked paper sources, skill assets, Node dependencies and managed Python
  runtimes were copied privately. Fourteen external links were relocated;
  all 20 initially broken links now resolve. Python 3.12/NumPy and Python 3.14
  execute. This does not certify every historical experiment or command.

## Private paths and reproducible entry points

On the Mini, migration state is under
`~/.local/lib/hapi-mini/wwx-consolidation-20261101/`:

- `owner.before.sqlite`, `wwx.before.sqlite`: validated standalone snapshots.
- `config.json`: source/target paths, current machine/cwd, existing code registry
  location, provider and installed Codex path. It contains no copied auth token.
- `prepared/manifest.json`: exact identities, raw-message digests and recovery provenance.
- `prepared/archives/`: full decoded historical messages, private and never committed.
- Current project `.hapi-history/`: installed full archives.
- Current project `.hapi-imports/`: relocated linked dependencies and source files.
- `workspace-audit.json`, `workspace-relocation.json`, `venv-config-before/`:
  original links, mapped targets and preserved generated environment configuration.
- `prepared/{native-validation,live-read,live-continuation,verified}.json`:
  native loader, both-identity reads, single-attempt continuation and final digest proofs.
- `source-before/`, `tenant-backends.before.json`: private source/config rollback.

Use the existing Mini Bun explicitly in non-login shells:

```sh
root="$HOME/.local/lib/hapi-mini/wwx-consolidation-20261101"
bun="$HOME/.local/lib/hapi-mini/bin/bun"
"$bun" "$root/tool/consolidate.mjs" prepare "$root/config.json"
"$bun" "$root/tool/validate-native.mjs" "$root/config.json"
"$bun" "$root/tool/consolidate.mjs" apply "$root/config.json"
"$bun" "$root/tool/consolidate.mjs" verify "$root/config.json"
"$bun" "$root/tool/verify-live.mjs" "$root/config.json" --read
"$bun" "$root/tool/verify-live.mjs" "$root/config.json" --continue
```

Preparation refuses to regenerate an existing manifest. Reuse its saved identities.
`validate-native.mjs --failed-only` rechecks only unresolved native loader cases.
Apply inserts only missing records in one transaction, preserves current records
and refuses differences/collisions. Final verification permits appended new turns
while checking every original message. Continuation intent is persisted before
each mutation; reconcile uncertain outcomes instead of replaying writes.
`repair-links.py` is the recorded one-time link relocation for this exact deployment;
it refuses changed links and retains the old targets/configurations.

## Owner projection and realtime

The existing private `data/tenant-backends.json` entry for `wwx` now has
`ownerVisible: true`. No backend token, public JWT or cookie is exposed to another
client. Owner lists deduplicate by original record ID, preferring the current
backend; operations for its session/machine IDs route to that backend once.
An unavailable configured backend produces an explicit failure, rather than a
misleading partial list or an operation against a stale source copy.

Each project has its own global SSE connection/cursor. Selected-session SSE is
routed by membership. Only the opaque visibility subscription handle receives
a backend prefix, which is removed when reporting visibility to that backend.
Frames are never interleaved between independent streams. Proxied SSE uses the
existing sync-flushed gzip implementation, preventing generic compression from
buffering an open feed. The original owner Desktop bypasses project config reads.

Production binary rollback is
`~/.local/lib/hapi-mini/bin/hapi-hub.before-wwx-consolidation-20261101`.
Restore the matching private configuration/source if rolling back the release.
Do not replace a live database with an old whole snapshot: new user turns may
have arrived. Reverse any data move only after ID-scoped comparison and retention
of newly appended turns. Original source records and snapshots remain available.

## Verification

Five migration tests, seven proxy/streaming tests and 43 existing SSE tests pass;
Web/Hub typechecks and the production Web/embedded-Hub builds pass. Vitest uses
the copied bundled Node runtime because running it under Bun hit an unrelated
Zod SSR import failure. Both identities read all 128 histories through actual
REST APIs. Loopback read-pair p50 was 17ms and p95 54–57ms; these are not public
network latency claims. Public browser acceptance checked the one WWX group,
an actual continued history, project SSE and visibility HTTP200, no API failures
in its final 27-request sample, no alert and no horizontal overflow.

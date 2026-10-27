# Restore development access after the Mac mini migration

This reviewed additive patch is staged on the Mini at
`~/.local/lib/hapi-mini/developer-access-20261028/`.
It has **not** been applied: SSH noninteractive sudo is unavailable.

## Scope

- Restore WWX public HTTPS through the existing `localhost:18080` CONNECT proxy.
- Restore SSH/SCP/SFTP/security and user scheduling executables; put the tenant's
  own `.local/bin` and `bin` first in PATH and allow ordinary temporary files.
- Default Codex to `danger-full-access` / `never` and Claude to
  `bypassPermissions`. Explicit HAPI UI modes still take precedence.
- Preserve independent Unix identity, owner files, other tenant data, private
  owner loopback interfaces and the scoped model proxy.
- RJJ's existing migrated session was resumed separately via native HAPI API
  with `permissionMode=yolo`. This package does not create an empty replacement
  RJJ account or discard its history.

## Apply and rollback

```sh
/opt/hapi-wwx/bin/bun /Users/zhuhe/.local/lib/hapi-mini/developer-access-20261028/apply-developer-access.mjs --check
sudo /opt/hapi-wwx/bin/bun /Users/zhuhe/.local/lib/hapi-mini/developer-access-20261028/apply-developer-access.mjs --apply
```

Apply checks the actual guest Hub for thinking/background tasks, backs up the
original policy/wrapper and config files to a root-only directory, and restarts
only the WWX runner. Existing idle conversations must reconnect/resume to
inherit the new process policy. The script prints the exact backup path.

```sh
sudo /opt/hapi-wwx/bin/bun /Users/zhuhe/.local/lib/hapi-mini/developer-access-20261028/rollback-developer-access.mjs '<exact backup path>'
```

## Validation and limits

- Mini dry-run, policy parse, wrapper shell syntax and both Bun bundles pass.
- Under the candidate policy, SSH version succeeds and a public HTTPS request
  through the established proxy returns 200. Direct owner gateway access fails.
  These checks ran as the SSH user under the candidate Seatbelt, not as the
  live WWX UID; live tenant execution remains pending administrator apply.
- A broader draft outbound rule was rejected after it unexpectedly permitted
  owner gateway access. That draft was never installed. The committed profile
  uses only the known public proxy path.
- This is not a full network/credential migration. The Mini has no default
  external route; the existing public proxy rejects private destinations.
  Corporate network/MLP authentication, SSH identities, Python/Git/tool/skill
  provisioning need separate matching access. No owner credentials are copied.
- WWX permission-mode API returned 409 (native ACK unavailable); readback shows
  `yolo` and preferred mode `yolo` on both sessions, which establishes stored
  state rather than a confirmed native settings update. RJJ resume returned
  200 and readback shows active/yolo in its original migrated directory.

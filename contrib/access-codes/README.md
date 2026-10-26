# Independent HAPI web access codes

The deployed Mini reads `$HAPI_HOME/web-access-codes.json` (regular file, owned by the hub UID, mode 0600). The version-1 registry maps opaque codes to fixed namespaces. Owner code maps to `default`, WWX code to `wwx`. Never construct guest codes by appending a namespace to a CLI token.

With the registry present, CLI credentials cannot web-login. Exact registered codes are required; suffix changes are rejected. An invalid or inaccessible registry fails closed with 503. The file is re-read per login. Existing JWTs expire after four hours; rotating `jwt-secret.json` and restarting the hub revokes all existing JWTs immediately.

The existing native desktop API accepts only the `default` namespace. Guest codes cannot list, read, send to, or control native conversations. The public `/desktop` HTML shell is static; access to desktop data and operations is enforced by the API.

`activate.mjs` is a one-time, guarded activation for the existing Mini deployment. It creates private rollback backups, rotates the CLI credential in both the hub and existing admin runner settings, creates independent owner/WWX web codes, rotates the JWT secret, replaces the compiled hub, restarts hub/runner and performs read-only checks. It refuses to run if already attempted or if an agent is generating. Run on the Mini via Bun after deploying and testing the source patch and compiling the candidate binary named in the script. It never prints credentials. The three open idle wrapper sessions at activation were disconnected; their persisted conversation records were retained. Native MacBook conversations use the separate desktop bridge and remain available.

`verify_public.py` runs on the MacBook with existing SSH access to `mac-mini`. It obtains codes into memory, tests public owner/guest access and tampering, and prints status codes only. Copy helpers place the selected code directly in the macOS clipboard without displaying or saving it.

## Current verified deployment (2026-10-27, Asia/Shanghai)

- 16 focused tests and the Hub typecheck pass; the Hub binary compiles.
- Public owner desktop project-list API: 200; WWX: 403.
- WWX suffix tampering, old shared owner code, current CLI credential used as web code: 401.
- Pre-rotation owner JWT: 401.
- Owner Mini runner is online; WWX sees zero owner machines.
- Access logs redact token/key query values; historical logs remain private and JWTs in them were revoked.

WWX execution is **not ready**. The isolated OS account/runner is absent and creating it requires an administrator password on the Mini. Do not attach a guest runner under the owner's UID or share the owner code to work around this. Provisioning and end-to-end sandbox/model verification are separate required work. The pre-existing guest installer is staged on the Mini at `~/.local/lib/hapi-mini/guest-admin-setup`; it currently describes both RJJ and WWX, so review/narrow its scope before use. It has not been executed by this change.

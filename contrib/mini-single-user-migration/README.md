# Mini single-user migration

WWX and RJJ are projects. Only `zhuhe` is an ordinary macOS account. This tool migrates the previously installed WWX services away from `hapi-wwx`; it never creates an account or changes sudoers. RJJ already runs under zhuhe and is untouched.

The three existing WWX labels and ports (3026/4126) remain. The wrapper uses the actual `HOME=/Users/zhuhe`, project-scoped HAPI/Codex/Claude state, normal owner development paths, and the existing egress proxy. It removes sandbox-exec and the guest port pool. Namespace/login-code/model routing remains as configured. Same-UID projects do not provide operating-system file isolation.

## Commands

Use the installed Bun runtime; no dependencies are installed:

```sh
/opt/hapi-wwx/bin/bun migrate-single-user.mjs --check
sudo /opt/hapi-wwx/bin/bun migrate-single-user.mjs --apply
/opt/hapi-wwx/bin/bun accept-live.mjs --run
sudo /opt/hapi-wwx/bin/bun migrate-single-user.mjs --finalize /var/root/hapi-wwx-migration/<backup>
```

`apply-and-verify.sh` performs these steps sequentially and stops on failure. System sudo requests the Mini password in the terminal. The tool does not save it.

`--check` only checks paths/platform; it does not open databases, stop services or authenticate. Apply refuses existing destination directories, unfinished thinking/tools/background work, queued/scheduled messages and insufficient space. It closes idle sessions through HAPI, stops the three original services and refuses leftover old agent processes instead of killing unknown jobs.

Apply makes a root-private backup of the service/project roots `.hapi`, `.codex`, `.claude`, `.claude.json` and `work`, verifies regular files and symlink targets by a SHA256 inventory, and takes SQLite backups including WAL. It copies this state to `~/.local/lib/hapi-mini/projects/wwx/home`, exposes its work directory at `~/Workspaces/wwx`, adjusts structured HAPI metadata and Codex cwd/rollout paths, and preserves transcript prose. Claude cwd aliases and internal absolute symlinks are repaired in the copied state. All migrated state is owned by zhuhe.

Only those five service/project roots are scanned, copied, searched for databases or changed in ownership. Other original home entries, including the entire macOS `Library`, Mail, Documents and Application Support, remain at the original location with their contents and permissions untouched. They are not represented as backed up or verified readable. The private `backup-scope.json` records both the copied roots and the entries retained in place. Project-local directories named Library are included normally. Inaccessible service/project files still fail. Readability and HAPI session workspace scope are checked before archiving sessions or stopping services; a session outside `work` stops the migration for review. Path mapping preserves references to uncopied profile locations instead of pointing them at missing destination files.

Apply verifies unchanged session IDs/message content, database integrity, service UID501, authenticated namespace routing and runner availability. Original chats remain in place. API histories were separately exported beforehand; those exports alone are not a full home backup.

Live acceptance creates one dedicated Codex session through HAPI with yolo permissions, checks UID501/HOME/project write/HTTPS, receives a real model reply, and resumes one migrated Codex history as zhuhe. It preserves the test session/proof and never deletes the account itself. Failure leaves the old account available.

Finalize separately rechecks service identity, database integrity, original IDs and fresh live acceptance, then removes only the old Directory Services account record. It retains the original home and the root-private service/project backup. The original home container and its five service/project roots become owned by zhuhe to keep historical project/attachment paths usable. Other profile entries retain their original ownership and contents; access to protected macOS profile data is not certified. No attachment rendering or Claude conversation-resume success is claimed until checked live.

## Recovery

Before finalization:

```sh
sudo /opt/hapi-wwx/bin/bun migrate-single-user.mjs --rollback /var/root/hapi-wwx-migration/<backup>
```

Rollback checks current work, closes idle project sessions, restores original plists/wrapper and starts the original services. Copied project files are preserved. Apply errors attempt the same service restoration automatically. Original home contents and the root-private backup remain available. A failed apply can leave a copied destination that needs inspection before another apply; it is deliberately not deleted.

After finalization, this tool refuses rollback because recreating the unwanted account is not permitted. Recover data from the preserved directories while retaining the single zhuhe account.

## Verification

`node --test migrate-single-user.test.mjs` (MacBook) and `bun test migrate-single-user.test.mjs` (Mini) cover a live committed WAL snapshot, exact message preservation during path rewrites, Codex rollout paths, Claude/internal symlink repair, busy-task detection, preservation of inaccessible macOS profile directories, mandatory service-data access and out-of-scope session refusal. These are offline checks. Actual root apply and real session acceptance still require the Mini's system authentication.

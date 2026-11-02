# Mini Hub deployment interruption — 2026-11-02

All times below are Asia/Shanghai (UTC+8).

The Desktop and HAPI web endpoints briefly lost their backend during the project-tree deployment at 22:38:53. The deployment receipt and installer establish the trigger: the installer atomically replaced `bin/hapi-hub`, sent SIGTERM to the old listener, and expected the existing LaunchDaemon's KeepAlive setting to start the replacement.

The first replacement process was rejected by macOS AMFI with `OS_REASON_CODESIGNING` / `Launch Constraint Violation`. The service became active again at 22:39:03 after fresh registration; the original deployment receipt records 14.213 seconds to verified HTTP recovery. Cloudflare reported origin connection resets through 22:39:06, followed by a canceled stream at 22:39:11. The SSH forward and Cloudflare connector retained their existing processes.

The installed candidate later passes `codesign --verify --strict`. It is an ad hoc signed arm64 executable; the absence of a CMS blob alone does not prove that this signature is invalid. The precise stale launch constraint or verification state behind the initial rejection has not been established. A controlled unregister/register cycle and candidate checks address the observed deployment failure without disabling macOS security controls.

The old installer had source and binary drift checks plus a rollback copy, but did not validate candidate startup before stopping the live listener, explicitly refresh the launchd registration, or automatically restore the previous binary after a failed launch. Its only startup failure action was to report that recovery was not confirmed.

The release helper in `contrib/mini-hub-release/` replaces this install-and-kill sequence. Live verification should distinguish successful installation, successful rollback, and rollback failure. Binary rollback must never restore the live database: new messages may have arrived since the deployment snapshot.

Evidence remains on the operator's machines: `install-project-tree.py`, `project-tree-refresh-deployment.json`, the Mini unified system log for 22:38–22:40, and the connector/SSH logs. Authentication values and conversation content are intentionally absent from this record.

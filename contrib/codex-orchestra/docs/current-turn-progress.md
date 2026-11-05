# Native turn activity source

The collector uses its existing single native read to compare the latest turn's item identities, roles, status, phase, output length and text content. It persists one bounded digest record per task/session, bound to the exact thread and turn, with the time when a semantic change was observed. It does not persist raw native text in this record. Repeated polls do not rewrite it.

The first observation, a new turn or missing items establishes an unknown activity time. A later semantic change in the same turn establishes progress. The native view revision includes duration and other metadata, so neither revision changes nor polling timestamps count as activity. The recorded time is the local observation of a change, rather than a claimed native event timestamp.

The watchdog reads the collector record only when it matches the current task's thread and turn. Explicit UNKNOWN prevents fallback to older source timestamps. Local rollout mtimes have no verified current-turn identity and are excluded from native task progress. Independent configured file watches retain their source semantics. A known activity timestamp still produces a stall after more than 1200 seconds without another change.

The installed watchdog has an independent source. Its exact change is retained in `patches/watchdog-current-turn-progress.patch`; the collector is maintained in `orchestra/collector.py`. Use the fixture runner in `fixtures/current-turn-progress/README.md` for isolated regression. Installation updates only these two runtime files; retain the current database, original task contracts, live mode, silent receipts and source configuration. Reload through the existing `install.py restart` entry. Roll back only the two runtime files from their installation backup; a full database restore would overwrite later controller decisions.

Without a trustworthy native event timestamp or a previously observed change, the elapsed inactivity duration remains unknown. Text is limited to the native view's existing bounded window. A change outside that window with no visible identity, status, output-length or text change cannot be detected from this source.

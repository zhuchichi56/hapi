# HAPI Desktop benchmark

Measure original-client behavior separately from the origin forward, public network and rendering. These scripts use the Python/Node standard libraries; they install no dependencies, create no service and do not generate model requests. Run manually after relevant updates. All conversation mutations remain in the original Apps.

## Inventory and organization

`inventory.py` opens the original Codex SQLite metadata in read-only mode and reads the configured Claude desktop session metadata. It distinguishes desktop, CLI, subagent and other origins; metadata alone never establishes running/completed state. Titles are truncated to 240 characters. Optional HTML is a private searchable catalog with original App links, not a second conversation store. It provides no mutation buttons. Neither inventory nor benchmark archives anything.

```sh
python3 contrib/native-desktop/benchmark/inventory.py \
  --codex-db "$HOME/.codex/state_5.sqlite" \
  --claude-directory /original/claude/desktop/session-directory \
  --output /private/run/inventory.json --html /private/run/conversations.html
```

Use the existing bridge config's `claudeSessionDirectory`. Inspect completion and pin/running state in the original client before selectively archiving through its supported tool or adapter. Keep an archive receipt with original IDs; do not infer completion from an old date, matching title or `notLoaded` status. Private inventories/IDs/HTML belong outside Git.

## API latency, correctness and transfer

Copy `config.example.json` into a private run directory, choose existing acceptance IDs and the actual network routes, and keep that config fixed for comparisons. Include one short/image chat and one tool-heavy history. There must be 3–30 repeats and at most four simultaneous routes; requests within each route are sequential, with no retry. Default `minItems=1` detects unexpectedly empty history; only an intentionally empty fixture should use zero.

```sh
python3 contrib/native-desktop/benchmark/api.py \
  --config /private/run/config.json --auth-ssh mac-mini \
  --output /private/run/api-baseline.json

python3 contrib/native-desktop/benchmark/api.py \
  --config /private/run/config.json --auth-ssh mac-mini \
  --baseline /private/run/api-baseline.json --output /private/run/api-after.json
```

`--auth-ssh` reads the existing Mini default-owner code once into memory and authenticates each HTTP route independently. It preserves current credentials. Alternatively supply `HAPI_BENCH_ACCESS_CODE` through the caller environment; never put access codes in config, arguments, logs or Git. Do not combine auth sources. The loopback Mini route assumes the already authorized private SSH forward exists; this script does not open a new listener.

Metrics: auth success, list/catalog/settings reads, history and revision-based incremental reads, older history and tool details when present; elapsed time, TTFB, wire-body/decoded bytes, HTTP/native failure, item count, identity and revision fingerprints. List/catalog/settings/older/detail currently run once per scenario as cold diagnostics; history/incremental run repeatedly. Samples contain no message text, tool output, raw errors, credentials or response bodies. Runtime cache is retained; `first observed` is not a guaranteed process-cold measurement. Public routes can contend on the same origin; cross-route differences are descriptive, not isolated causal trials.

The gate requires every attempted request and payload/identity check to succeed, each case's p95 to meet its configured budget, and no missing or regressed comparable cases. Exit 2 means failed budget/quality, exit 0 means passed. Insufficient samples, unavailable baselines and unchanged pre-existing failures are identified separately. Failed routes cannot become green by disappearing from averages. Relative latency comparisons require at least three successful samples; revisions/config/protocol must agree. Median regressions exceed both 20% and 50ms. Single-sample timings remain diagnostics. With five samples, nearest-rank p95 is simply the maximum; it does not certify long-term reliability or concurrency capacity.

## Browser loading and interaction

First open/authenticate an **independent agent-browser session** using the `agent-browser` Skill, then get that same session's CDP endpoint. Never attach to a personal Chrome profile or auto-discover another task's browser. Both commands below require an exact already-open URL on an explicit loopback CDP endpoint.

```sh
node contrib/native-desktop/benchmark/browser.mjs \
  --cdp "$OWNED_CDP" --url "$OWNED_DESKTOP_URL" \
  --output /private/run/browser.json

node contrib/native-desktop/benchmark/ui.mjs \
  --cdp "$OWNED_CDP" --url "$OWNED_CODEX_IMAGE_CHAT_URL" \
  --output /private/run/ui.json
```

`browser.mjs` performs three cold-cache/warm-cache pairs in normal conditions, then three pairs at 200ms/512000Bps down/256000Bps up/4× CPU slowdown. Login is already complete and not included. It measures first original-message paint, FCP, observed lab LCP/CLS, long tasks, browser-reported JS heap (when available), DOM size, asset bytes, two-frame model-menu paint, API errors and ten seconds of history polling. Main budgets: first message ≤5s, CLS ≤0.1, no alerts/overflow/API failures, and completed serial polling. The menu must actually appear in the Codex scenario. Service-worker handling and throttling are restored in `finally`. Cold-cache clearing affects only the explicitly owned browser.

Pass `--baseline /private/run/browser-before.json` to compare matching target, browser, viewport and profiles. A first-message median increase above both 20% and 100ms fails. Small public-network samples remain variable; retain all runs, including failures, rather than retrying until green.

`ui.mjs` checks a Codex image fixture at 1440/390/320px: no horizontal overflow, loaded thumbnails ≤180px, model panel within viewport. It also measures 60 synthetic scroll-frame gaps and restores scroll/viewport. Run it on a scrollable tool/history fixture for a representative long-history scroll measurement; a short image fixture does not establish long-history FPS. These laboratory probes are **not field INP, real-device FPS, 75th-percentile Core Web Vitals or native App RSS**. Real INP needs representative trusted interactions/field collection; do not relabel menu timing as INP.

## Functional scope and limits

Read-only probes do not verify send, image submission, stop, approval, model writes or archive parity. Reuse the focused adapter/UI tests and isolated original acceptance checks for those operations, preserving identity/state and never replaying uncertain writes. Current question matrix: Codex `item/tool/requestUserInput` has choices/custom answers and native submission; unsupported request methods remain explicit. Claude currently exposes allow/reject approval controls, not arbitrary `AskUserQuestion` choices. Genuine pending UI must be observed before claiming live end-to-end coverage. Do not trigger questions in users' active chats merely to benchmark.

```sh
python3 -m unittest discover -s contrib/native-desktop/benchmark -p 'test_*.py' -v
node --test contrib/native-desktop/native-host.test.mjs
```

Method references: [Web Vitals](https://web.dev/articles/vitals), [threshold methodology](https://web.dev/articles/defining-core-web-vitals-thresholds). Our custom first-message/network budgets are product targets, not Google's thresholds. The 2026-11-01 search fetch returned cached official material; local live measurements are the authority for this deployment.

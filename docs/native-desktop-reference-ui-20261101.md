# Desktop reference UI · 2026-11-01

The supplied screenshot guided four actual visual iterations. Scope is typography, sidebar rhythm, message width, composer and status styling. Exact screenshot font/scaling is unknown; live inspection identifies SF and PingFang SC after the change.

## Result

- Prose 14→15px, sidebar titles 12→14px, user/input 13→14/15px; mobile input remains 16px.
- Sidebar 244→260–286px. Prose and composer share a 900px border-box container with 24px gutters (852px effective at 1440px).
- Desktop send/attach/copy controls 32px; mobile 44px. Existing models, images, native operations and brand components remain.
- Four rounds: type → sidebar/message spacing → composer/status → remaining sidebar action text. Seven final live widths 320–1440px have no overflow.

## Comparable measurements

The existing Desktop profiler's 200ms latency/512000Bps/4×CPU conditions were reused and extended to a fixed synthetic 48-thread,24-turn,72-item fixture. Chrome 156.0.8078.79,1440×1024, same public origin/account/session, native reads served in-page at a fixed 200ms; no native writes. Service worker bypassed; cold HTTP cache disabled, warm enabled. Each cache condition ran three times before and after deployment.

| Metric (p50 / p95, ms) | Before cold | After cold | Before warm | After warm |
|---|---:|---:|---:|---:|
| First message |3168 /3328|3214 /3375|2011 /2158|1855 /1887|
| Input → two frames |32.1 /36.6|32.2 /40.7|31.9 /46.7|32.2 /33.9|
| Wheel → two frames |65.3 /68.4|66.1 /67.4|66.1 /67.8|65.9 /67.3|
| Thread switch, readable + connected |316.9 /433.5|316.7 /478.5|332.2 /414.8|317.3 /379.8|

All 12 final runs passed with zero page errors/visible fixture errors/overflow. Input and scrolling include automation overhead and two animation frames; they are not INP. Load n=3 per cache, so p95 is the sample maximum. Encoded resource-body sizes 514593→515219B (+626B,0.12%); this is not warm network transfer volume. No material regression is established; warm-load improvement is a short-sample observation. Cold p95 switch increased 45ms, within the pre-release 15%/50ms investigation threshold. CLS about 0.0334→0.0325 existed in the baseline as well.

The first post-reload public navigation returned HTML502. Another later public navigation's first HTML byte took 61.49s, preceding CSS/JS execution; it subsequently loaded successfully. Public-path latency variability remains, with root cause unestablished. Earlier project speed records already document public timeouts. Neither failure is hidden in the successful fixed-fixture sample.

## Source and deployment identity

Implementation commit: b3c59899. Based on completed rendering/model fixes effc7b34 +132dd2e1. Only scoped CSS is added. Before installation,711 runtime/build files matched current live source; existing auth/owner/branding customizations remain. 58 focused tests, Web typecheck, production build and embedded Hub compile pass.

Mini isolated build: ~/.local/lib/hapi-mini/builds/desktop-reference-t006-20261101/.

Production Hub SHA256: 5cceefb0074d043ff3311f8f995a0d872fb92e3c2c63ea336211e3945d6165eb.

Previous Hub: d65666ae8d9adac6426a6fb18e946196d86104cfb1d0030e679daeeab3f496e4.

Guarded rollback: ssh mac-mini 'python3 ~/.local/lib/hapi-mini/rollback-reference-t006.py'. It refuses to overwrite a later binary or CSS change.

Evidence is retained in this task's local outputs/Desktop_UI_改进/, including every raw trial, benchmark entry, conditions and fixture hash, screenshots, font/platform measurements, live interactions, manifests, logs and deployment receipt. Screenshots may contain private conversation content and are not committed. The initial benchmark harness used an ambiguous substring selector; its six failed trials were retained, then corrected before the final baseline. No model messages or stop/settings mutations were submitted.

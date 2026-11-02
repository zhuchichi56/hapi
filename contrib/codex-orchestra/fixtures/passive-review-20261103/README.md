# T022 isolated passive review comparison

These are labelled simulator measurements, not native internal Agent/model throughput. Both modes use the same eight-receipt workload, transport/review delays and four-worker budget; SQLite commits and monotonic wall timings are real. Baseline is serial parent policy; optimized uses three durable candidate reservations and one wake worker. No parent review or decision is synthesized. Each mode has all three repeats; early instrumentation raw remains in the task workspace.

`mixed_workload.py --source PACKAGE_ROOT --mode baseline|optimized --repeat 3 --result RESULT.json` uses a package root containing `orchestra/`. Pass the pre-change package to baseline and this candidate to optimized; using the current package for both does not reproduce the original pre/post code comparison. Frozen workload SHA256 and environment are embedded in raw JSON.

Planner independently recalculated mean ± sample standard deviation: baseline 1.46409 ± 0.01370s, optimized 0.63088 ± 0.03262s; controlled ratio 2.32071. Actual native parallel validation is separately performed by the parent with genuine internal tools and is not represented by these simulated delays.

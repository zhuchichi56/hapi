# Current internal receipt policy (2026-11-03)

Native chat wakes now default OFF. The persistent Ledger meta key `receipt_native_wake_enabled` must equal literal string `1` to enable wake dispatch; missing/0/invalid values stay silent. Background receipt ingestion, deduplication, ACK and candidate collection continue. OFF does not remove or complete pending/unknown wake rows. This policy overrides older automatic-wake descriptions below. Trusted local configuration uses `ledger.set_meta('receipt_native_wake_enabled', '0')`; the collector and every Ledger wake dispatch re-read the key. An already-started native I/O operation cannot be retracted. Direct standalone native adapter calls are outside this Ledger policy.

# T022 私有候选队列 API（不代表验收）

此候选仅返回 verification candidate evidence。parent alone reviews/decides。队列不会调用 receipt-review、decision-update、任务验收或原生工具。CLI 属于现有本机私有 Ledger 信任边界；`--actor`、dispatchId、executionId、evidence 都是**不受信的本地操作员声明**，不是经过认证的真实 tool invocation。父控制器必须独立供应并核对真实工具身份与结果。

## 入口与只读操作

在本候选根目录执行（`STATE` 必须由父控制器指向其授权的私有 ledger；下列测试路径仅为示例）：

```sh
export PYTHONPATH="$PWD/output"
STATE="$PWD/output/parent-verification-state"
PARENT=01a19339-39e6-7081-8920-82db9992402a
uv run --offline --no-project python -m orchestra --state "$STATE" review-queue ready --limit 20
uv run --offline --no-project python -m orchestra --state "$STATE" review-queue list --limit 20
uv run --offline --no-project python -m orchestra --state "$STATE" review-queue package --event EVENT_ID
uv run --offline --no-project python -m orchestra --state "$STATE" review-queue metrics
```

测试 ledger 首次初始化使用全新目录和全局 `--test`，test mode 会跨重启持久保留。list/ready/metrics 默认排除 test 数据；显式增加 `--include-test` 才显示。package 按明确 eventId 读取私有证据，不受统计排除影响。任何 queue 数据均未加入 HTTP/public snapshot；T021 projection 的键与语义保持原样。

`ready` 是有界 coalesced ready-package summary，返回相同排序的 event locators/job metadata；`package` 提供精确 receipt JSON（checklist/evidence/limitations）、receivedAt、task goal/acceptance/ownership/authorization、owner instructions 和 expected candidate output。上限 100，默认 20。这不是 native wake batch。

## 最小动作协议

所有变更经 `Ledger.verification(action, data, actor_id=PARENT)` 或下面的 CLI：

```sh
uv run --offline --no-project python -m orchestra --state "$STATE" review-queue claim \
  --actor "$PARENT" --json output/contracts/claim.json > output/claim.json
```

claim 返回 JSON job 或 null。每个 eventId 最多一个 job。`state=claimed` 只表示 scheduler reservation，**不是 native 模型响应、启动、审查或接受**。返回 `token` 与 `revision`；后续变更都必须带这两者和 eventId，priority 除外。

| action | JSON 除 eventId/token/revision 外的字段 | 语义 |
| --- | --- | --- |
| claim | owner，leaseSeconds 可选，默认 60，范围 1..3600 | 全局原子容量检查 + 领取一个 eligible job；无需 event/token/revision |
| start | dispatchId，executionId 可选，leaseSeconds 可选 | 首次持久记录 dispatch intent；若尚无 executionId 则进入 dispatching；父调用 native tool 后再次 start 绑定真实 executionId |
| renew | leaseSeconds 可选 | 延长未过期 claim/dispatch/running lease；返回新 revision |
| submit | summary，evidence（1..50 引用），limitations（0..50） | 仅 known running 执行可提交；标记 candidate finished，绝不审查 receipt/创建 decision |
| release | reason | 仅释放尚未 dispatch 的 reservation，进入 backoff/failed |
| reconcile | outcome，evidence；active 可带 executionId/leaseSeconds；completed 必须带 summary/limitations | 父独立确认 active/completed/stopped/not-started/unknown；unknown 保留占位；completed 仅 candidate |
| configure | maxInflight（1..4） | 持久全局容量，默认 3；无需 event/token/revision；不可降到已有占位数以下 |
| priority | priority（0..10），eventId，revision | 仅 queued；无需 token；age 每 60 秒相当于 +1，旧任务不会被持续新高优先级任务饿死 |

可直接运行的 JSON 生成示例（先确认 output/claim.json 非 null；请使用本次真实返回值）：

```sh
uv run --offline --no-project python - <<'PY' > output/start-intent.json
import json, uuid
c = json.load(open('output/claim.json'))
assert c is not None, 'no claimable slot/job'
print(json.dumps(dict(eventId=c['eventId'], token=c['token'], revision=c['revision'],
                     dispatchId='parent-dispatch-' + uuid.uuid4().hex, leaseSeconds=120)))
PY
uv run --offline --no-project python -m orchestra --state "$STATE" review-queue start \
  --actor "$PARENT" --json output/start-intent.json > output/dispatch.json
```

**必须先成功持久化上述 dispatch intent，再由真实 parent/root 调用其已经暴露的原生 collaboration spawn/followup 工具。** 该 CLI 不能后台创建 native subagent。父把 package 的 instructions、receipt 和 ownerInstructions 给实际子代理，要求返回 summary/evidence/limitations，拒绝给其验收权限。真实工具返回 agent ID 后，父更新请求并再次 start：

```sh
# REAL_AGENT_ID 由父从真实工具回执读出；不要填模拟 ID 来声称原生验证。
REAL_AGENT_ID='REPLACE_WITH_PARENT_TOOL_READBACK'
export REAL_AGENT_ID
uv run --offline --no-project python - <<'PY' > output/bind-start.json
import json, os
c = json.load(open('output/dispatch.json'))
print(json.dumps(dict(eventId=c['eventId'], token=c['token'], revision=c['revision'],
                     dispatchId=c['execution']['dispatch_id'], executionId=os.environ['REAL_AGENT_ID'],
                     leaseSeconds=120)))
PY
uv run --offline --no-project python -m orchestra --state "$STATE" review-queue start \
  --actor "$PARENT" --json output/bind-start.json > output/running.json
```

之后每次 renew/submit/reconcile 均从最新返回 job 复制 eventId/token/revision。父读取真实子代理结果并生成：

```json
{"eventId":"EVENT_ID","token":"LATEST_TOKEN","revision":4,
 "summary":"Candidate findings only","evidence":["exact:file-or-tool-result-locator"],
 "limitations":["Any missing checks; no acceptance authority"]}
```

存为 output/submit.json，再执行：

```sh
uv run --offline --no-project python -m orchestra --state "$STATE" review-queue submit \
  --actor "$PARENT" --json output/submit.json
```

父随后独立复核候选证据，使用**现有** receipt-review/decision API 自行决定；队列不会推进这些阶段。相同请求在无后续变更时可精确重放（revision+1 对应同 action/JSON）；旧 token/revision 永远不能完成新 claim。dispatchId 全局唯一，不能跨 claim 重用。

## 恢复与容量

全局 writer transaction 在同一个 SQLite Ledger/factory 上执行，FULL sync，无 I/O 在事务内。原子 claim 会回收所有过期 reservation：尚未 dispatch 的任务 backoff 重排；已经 dispatching/running 的任务变为 reconciliation-needed，继续占据全局容量，不会盲目重启仍活跃或状态未知的 native agent。读取 list/metrics 不变更状态。

遇到 expiry 后的直接 start/renew/submit 会拒绝。父可以直接以当前 revision reconcile 已过期 execution，或运行一次 claim 先持久化 recovery，再 list/package 读取最新 revision。outcome=active 重新绑定/核对 executionId 并续租；outcome=unknown 永久保留占位直到父明确确认。outcome=stopped 必须由父确认执行已停止；not-started 只适用于尚无 executionId 的 dispatch intent。释放/确认停止/未启动/过期 reservation 的重试最多 3 次，backoff 为 2^attempt 秒（2、4、8）；第三次后 failed，不无限重试。failed 没有自动重置入口，交给父人工处理。

进程重启后 mode、容量、token/revision、租约、dispatch identity、candidate 与 history 都来自 SQLite。无法确认的执行可能阻塞全部槽位，这是明确的安全阻塞，父必须 reconcile；不根据时间推断原生执行已结束。

## durable receive 与既有 wake

`Ledger.receive_receipt(payload)` 和 `LedgerReceiver.receive_receipt` 的生产 passive 路径在 receipt + notice + wake + verification job 同一事务提交后立即 durable ACK。不等待 NativeWakeAdapter。显式 `wake_mode='sync'` 保留同步行为；Python 显式传 `wake_adapter=...` 且不指定模式也保留旧同步行为。CLI `receipt-receive` 默认 durable；`--sync-wake` 显式等待（`--wake-controller/--bridge-socket` 可选择 adapter）。

现有 daemon 的 ReceiptRecoveryCollector 在原有 cadence/executor 上 drain persisted wake queue，仍通过原先固定 controller 的 proven NativeWakeAdapter send/read-marker 协议实际唤醒父；没有新增服务/端口/定时器。daemon 不运行时仅持久入队，需要父启动现有 daemon 或手动恢复：

```sh
uv run --offline --no-project python -m orchestra --state "$STATE" receipt-drain --wake-controller --limit 20
```

wake 仍是逐事件，**未实现合并原生通知、未声称批量发送**。ready 提供 coalesced package summary。原 wake/outbox 的 sending claim、wire attempt ID、unknown 只读 reconciliation、已证明 not-sent 的最多 3 次重试协议保留。只有真实原生 user marker readback 才能标记 sent；不存在虚构 batch 或逐事件提前标记 sent。

## 指标

`verification_metrics` 返回 receivedAt、wakeMarkerVerifiedAt、firstClaimAt、parentDispatchRecordedAt、parentStartRecordedAt、candidateFinishedAt、controllerReceiptReviewAt、decisionCreatedAt、decisionAt、executionConfirmedAt、verifiedAt。后五者来自现有 controller review/decision 数据，候选提交不会填充它们。

每个 receive→stage 指标包含 count、missing、invalidClock、mean、p50、p95、maximum；总样本数、receipt/queue coverageStartAt、test scope、UTC wall clock 与限制一起返回。负时差计 invalid，不截零；缺失不填假值。wake marker 表示消息写入父线程并被 adapter 读回，不表示父已处理或已审查。dispatch/start/result 的 recordedAt 仅为本地操作员记录时间，不能据此宣称真实 native 模型延迟或 acceptance。benchmark 使用独立 monotonic clock，明确区分这些限制。

指标补充：`executionConfirmationRecordedAt` 单独表示父首次把 execution-confirm 写入 decision revision 的时刻；`executionConfirmedAt` 保留既有 actionConfirmedAt 语义（执行 receipt 的 durable receivedAt）。decision/执行/verify 的指标读取现有 revision history，取每个 receipt 最早已记录阶段；rework 不会使已记录历史从这些私有指标消失。coverage 与 stageDefinitions 明确说明来源。ready 的 packageSummaries 合并 task/kind/receipt summary/checklist状态计数/limitations数量与精确 package 命令，不包含 native batch 身份或发送副作用。

claim 是一次 allocation；若 CLI 回应丢失，先 list 并按 owner/token/revision 确认现有 reservation，再继续，不能据失败推断尚未领取。start/renew/submit/release/reconcile 的精确即时重放可返回已提交状态；后续新 revision 会拒绝旧请求。

## Planner correction：controller-reviewed receipt 不再次派发

父调用现有 receipt-review 得到 accepted、needs-rework 或 rejected 后，同一 writer transaction 会将 queued 或尚未派发的 claimed job 置为明确终态 `controller-reviewed`，清除 reservation token/lease 并增加 audit revision；不填 candidate 或 candidateFinishedAt。相同 review 的幂等重放不增加重复退休 revision。receipt 是不可变事件，needs-rework 也不能让原 eventId 再跑；新交付使用新 eventId。

duplicate receipt、reservation expiry、重开 ledger 和并发 review/claim/start 均不能使该事件重新领取/派发。ready/claim 也排除已有 review/decision 的遗留事件；旧候选 v1 的 SQLite CHECK 自动升级，保留 runs/history/外键，初始化将尚未派发的既有 reviewed job 退休。review 与 claim/start 使用同一 SQLite writer 锁：若 review 先提交，旧 reservation start 被拒；若 dispatch intent 已先提交，review 不会撤销它。

**dispatching/running/reconciliation-needed 的容量不会仅因 receipt-review 而释放。** 父仍需确认实际执行 stopped/not-started 才能 reconcile 释放；此时已有 review 的 job 直接进入 controller-reviewed，不再 queued。已派发执行可正常绑定、续租、提交实际返回的 candidate 或 reconcile，不能把 receipt-review 当作执行结束证明。

当前默认 collector poll interval 为 5 秒；空闲期 durable ACK 后，native wake 可能额外等待一个 poll interval，并叠加 executor 排队/transport 时间。ACK 时延不等于 parent handling/native 响应时延。真实父收到通知后可按本文 ready→claim→package→persist intent→真实 collaboration tool→bind→submit 流程运行。

既有 strict private ReceiptAck schema 的 optional wakeMode enum durable/sync 由 planner 在 merge 时更新/replay；本候选没有执行该旧 schema 验证，不把本地回归通过称为其已通过。T021 public projection 继续冻结，逐事件 native transport 不变。

## 第二次纠偏：原样绑定真实 canonical task name

仅 `executionId` 增加专用 validator：允许原稳定 ID/UUID，以及 `/root/t022_native_slow`、`/root/t022_native_fast`、`/root/parent/child_1` 这类前导 `/` 的层级 canonical path；总长度仍最多 160，逐段非空，拒绝空白、换行、控制字符、重复 `/`、`.`/`..` 路径段及超长值。原样保存，不 strip、alias、重命名或声称认证。eventId/token/owner/dispatchId 等仍走原 ident，不允许前导 `/`。

start direct-start、既有 dispatch intent 的 bind，以及 reconcile supplied/stored identity 都使用此专用校验。这里的 canonical 字符串仍是本地操作员声明，真实工具调用和身份须父独立核验。

**不要因为原包 bind 失败而重新 spawn。** 父已有真实工具返回值时，对尚未过期的 intent 用最新 eventId/token/revision 和同一 dispatchId 再 start 绑定真实 executionId；已经过期或 reconciliation-needed 时，直接以最新 job/token/revision `reconcile outcome=active` 绑定/续租既有执行。以下仅示意已由父核对为 active 的原执行，不能据脚本自己推断工具状态：

```sh
uv run --offline --no-project python -m orchestra --state "$STATE" review-queue package --event EVENT_ID > output/latest-package.json
uv run --offline --no-project python - <<'PY' > output/reconcile-existing.json
import json
j = json.load(open('output/latest-package.json'))['job']
print(json.dumps(dict(eventId=j['eventId'], token=j['token'], revision=j['revision'],
                     outcome='active', executionId='/root/t022_native_slow', leaseSeconds=120,
                     evidence=['REPLACE_WITH_PARENT_REAL_TOOL_RESULT_LOCATOR'])))
PY
uv run --offline --no-project python -m orchestra --state "$STATE" review-queue reconcile \
  --actor "$PARENT" --json output/reconcile-existing.json
```

增量关系：`incremental-execution-id/execution-id.patch` 只变更 review_queue.py、test_review_queue.py，基于执行器 17:45 交付的两文件（base/after SHA256 见同目录 evidence.json）。冻结的 stage2-parent-qa-package 未读取/修改，父应先将其源码与 base SHA 比对；不得把完整 candidate.patch 重复当作该冻结包的增量。`candidate.patch` 仍是相对原 input/orchestra 的完整候选补丁。冻结原包的真实审计记录保留，本次另列原 validator 失败与修正后的隔离证据；没有重派工具或触碰父控隔离 state。

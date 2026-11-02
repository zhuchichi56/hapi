# T022 修正版集成说明

本版本落实 `PLANNER-NOTES.md` 和 T021 frozen public-safe contract，取代未验收初稿。代码在 `output/orchestra/`；未部署、commit、写生产或真实发送。executor 截止 16:37:29Z、父截止 16:48:01Z 均未延长。

## 精确文件范围

现有源码只改副本 **5 个扩展点**：`db.py` additive schema；`ledger.py` mixin/构造参数及 snapshot 的两个新字段；`cli.py` 新命令；`server.py` 私有 GET/HEAD；`daemon.py` 接入既有 collector 的恢复子类和 bridge adapter。

新增 **7 个文件**：`receipt_schema.py`、`receipts.py`、`receipt_delivery.py`、`receipt_cli.py`、`decision_projection.py`、`receipt_recovery.py`、`test_receipts.py`。`collector.py`、`projects.py`、T015 catalog/展示逻辑及其余 14 个 installed Python 文件字节不变。没有 project 树、UI 或新服务修改。

`output/t022.patch` 仅含上述 12 个文件；`manifest.json` 有输入/输出 SHA-256。planner 应按最小 hunks 合并 5 个扩展点，保留其他人的修改，不能整树覆盖。补丁在临时 input 副本 dry-run/apply 均返回 0，重建 26 个 Python 文件全部逐字节匹配。`schema.sql` 是复用现有连接安装的 7 张表。

## 给 T021 的冻结投影

入口是既有注入宿主快照 **`snapshot.systemDecisions`**，无需浏览器访问 socket，无新轮询/代理。`output/public-interface.json` 是该形状的独立 JSON Schema；`interface.json` 根为内部私有统计，`$defs.PublicProjection/PublicDecision` 同时给出公共契约。`sample.json.publicSnapshots` 是带 test 标记的模拟回放，不能打包进生产 preview。

公共 envelope 的完整键为：

```text
version, projection, safeDisplay, generatedAt, statisticsStartAt, clock, coverage, decisions
```

固定 `version=1`、`projection='T022-public-safe/v1'`、`safeDisplay=true`。coverage 为 `{currentComplete, historyComplete, firstDecisionAtImmutable}`，最后一个为 true。currentComplete 表示该 ledger 授权范围内已经声明的完整 decision 集；未分类 receipt 不推定成 decision，另列 backlog。historyComplete 只承诺 statisticsStartAt 之后保存的记录，绝不承诺部署前历史。没有首个 durable receipt 时 statisticsStartAt=null、historyComplete=false。

公共 record 的完整键为：

```text
decisionId, taskId, stageId, revision, decisionRequired, authority, waitingOn,
state, triggeredAt, decidedAt, actionConfirmedAt, verifiedAt, dueAt, clock,
test, rework, revoked, question, nextAction, owner
```

`decidedAt` **始终映射内部不可变 firstDecidedAt**，不是当前/latest choice。rework 后仍保留该历史值，当前 state 回 pending，当前 actionConfirmedAt/verifiedAt 清空。`test` 明确布尔；默认 snapshot 和 HTTP 都排除 test。question/nextAction/owner 仅来自 controller 在 create/choose/revise 中专门声明的 `publicDisplay`，值必须 null 或 <=160 字符且无控制字符；不声明就 null，绝不从 raw trigger、reason、nextAction、owner、options/evidence 截断复制。内部字段变化而没有重新声明安全值时相应展示值清空。不能把客户端截断当 safeDisplay 保证。

`Ledger.snapshot()` 的完整顶层键是：

```text
version, generatedAt, controllerThreadId, collector, tasks, sessions,
pendingTaskCount, queuedTaskCount, runningSessionCount, notices, operations,
systemDecisions, receiptReviewBacklog
```

现有 server `/snapshot` 保留 T015 的 `projectCatalog`，catalog 错误时还可能有 `projectCatalogError`；task artifacts/presentation 仍由原逻辑附加。`sample.hostSnapshotKeys` 列出实际 Ledger keys，`sample.hostSnapshot` 仅存两个新增安全字段的 slice，不复制原任务/notice 内文。

`receiptReviewBacklog` 是独立安全 envelope：version/generatedAt/count/oldestWaitSeconds/receipts。每项仅 receiptId/taskId/kind/receivedAt/waitSeconds，无 summary/source/evidence。内部查询也有同样 backlog 和 `counts.unreviewedReceipts`。receipt 尚未形成 decision 时就可查询；独立 verify 会给 execution receipt 追加显式 controller receipt-review，使已审核执行证据退出 backlog。旧 notice ack 不会替代 review。

## 修正后的时间、计数和执行语义

- 内部 UTC，triggeredAt 固定为关联 receipt **首次服务端 receivedAt**，triggerBasis='receipt-received'，clock='orchestra-ledger-received-utc/v1'。source occurredAt 单独保存，不作为默认统计时钟；recordedAt/createdAt 是后来录入 decision 的时间。收件到录入期间的 inbox 等待纳入 receipt-to-first-decision latency。
- firstDecidedAt 首选后不可变；decidedAt/latestDecidedAt 是内部当前/最新选择，rework 不清 first。累计 `counts.decided` 包含每个曾选择过的唯一 ID，**包含 revoked 和 rework-pending**。`currentlyEffective` 单独表示当前 chosen/action/verified 且未 revoked，不是效果评分。revision 不增 ID/sample 数。
- `pending` 仅是当前待选择的合法决策，包括 controller/user/external 和 rework；不混入执行或父验证等待。`pendingDecisionWait`/兼容 longestWait 是当前 pending 集合中从首个 receipt trigger 计的最长等待；`allUnresolvedWait` 在所有未 verified/revoked 集合上计。单位明确 seconds；空或不可信时间为 null，不把负钟差钳成 0。
- latency 每个曾决定 ID 只取 firstDecidedAt-triggeredAt 一次，重做/撤销保留；nearest-rank ceil(p*n)，显式 sampleCount/missing，无样本 P50/P95=null。缺失或负时间不制造样本；逆向服务器时间的选择/确认/验证会拒绝。
- `knownOverdue` 是已知 dueAt 已过且 unresolved 的个数；`missingDueAt`/`overdueUnknown` 是 unresolved 无 deadline 个数。有缺失时总 overdue=null、coverage.overdueComplete=false，不声称 overdue=0 完整。公共 dueAt 保留 null，供 T021 自行表达 unknown。

状态与独立动作：

```text
pending --choose--> decided --action--> action-pending
       --execution-confirm (仍 action-pending)--> --verify--> verified
```

execution-confirm 需要 action 之后首次持久接收到的同 task execution receipt 和非空执行证据，actionConfirmedAt 采用该 receipt 的服务端接收时刻；其 source 时钟不用于跨时钟比较。delivery/failed execution report 均可证明已执行/尝试，不能把失败的 checklist 当成“没执行”；独立 verify 仍要求 delivery、全部 pass/evidence、非空 verification evidence、授权 verifier 与 owner/worker session/source 不同。verify 不接受 executionReceiptId 来跳过确认。controller 自己执行的 action 在固定 verifier API 内不可自证。

`awaitingExecution` 是当前 chosen 且没有 actionConfirmedAt（包括尚未 action-start 的 decided）；`awaitingVerification` 是已有 actionConfirmedAt 但没有独立 verifiedAt。`actionPending` 是这两类之和。rework 清空当前 execution/verification 证据引用和时戳，旧版本完整保留；revoked 不删除历史 first choice/latency。

## API、CLI 与信任边界

所有客户端走 Ledger API，无 direct SQLite 客户端通道。完整内部证据留在 `receipt-get`、`decision-get --history` 和私有 GET `/decisions`；公共投影没有内部 raw evidence/reason/options/native bodies。

```python
ledger.enqueue_receipt(payload)
ledger.dispatch_receipt(event_id, LedgerReceiver(ledger))
ledger.receive_receipt(payload)  # 先 commit，再立即尝试 fixed-controller wake
ledger.review_receipt(event_id, review, actor_id=controller)
ledger.create_decision(decision, actor_id=controller)
ledger.update_decision(decision_id, update, actor_id=controller)
ledger.decisions_snapshot()         # internal, test excluded
ledger.public_decisions_snapshot()  # frozen safe projection, test excluded
```

create 必须独立 receipt review、精确 task/session/turn linkage、decisionRequired=true；普通 notice 不创建决策。controller 固定 `01a19339-39e6-7081-8920-82db9992402a`；user/external choice 需 controller 记录真实 authority identity + evidence，不能用 worker/controller 代替。

actor_id 是**可信本机调用者的身份断言，不是认证凭据**。worker receipt JSON 不可带 acceptance/review，worker actor 被拒绝；但同一 OS 用户恶意进程若能假称 controller 调用 CLI，本模块本身不能证明真人/父会话独立审核。planner 必须在实际入口认证 actor；只有真实父 read/review 才是 E2E 验收。

可执行隔离示例：

```sh
export PYTHONPATH="$PWD/output"
example_state="$PWD/output/example-state"
controller_id="01a19339-39e6-7081-8920-82db9992402a"
python3 -m orchestra --state "$example_state" --test register --json output/examples/task.json
python3 -m orchestra --state "$example_state" receipt-enqueue --json output/examples/receipt.json
python3 -m orchestra --state "$example_state" receipt-deliver receipt-complete
python3 -m orchestra --state "$example_state" receipt-get receipt-complete
python3 -m orchestra --state "$example_state" receipt-review receipt-complete --json output/examples/review.json --actor "$controller_id"
python3 -m orchestra --state "$example_state" decision-create --json output/examples/decision.json --actor "$controller_id"
python3 -m orchestra --state "$example_state" decision-update decision-complete --json output/examples/choose.json --actor "$controller_id"
python3 -m orchestra --state "$example_state" decision-update decision-complete --json output/examples/action.json --actor "$controller_id"
python3 -m orchestra --state "$example_state" decisions --include-test
python3 -m orchestra --state "$example_state" receipt-drain --limit 20
```

expectedRevision 做 CAS。`output/cli_smoke.py` 进一步用 action 之后新生成的 execution receipt 演示 execution-confirm(revision=3)、verify(revision=4) 和最终 history；19 个真实 subprocess CLI 调用全通过，独立 test ledger，未调用 native。静态 execution/verify JSON 引用回放 receipt，不能用不存在/旧的执行证据直接验收。

私有 GET `/decisions?task=T022&state=pending&waiting=waiting-user` 保持内部 envelope，public-safe shape 从 `/snapshot` 注入。socket 当前 uid 所有且 0600、父目录当前 uid 所有且 0700，否则 `/decisions` 403；非法/重复 query 400，写 HTTP 方法 405，HTTP 不开放 test 查询。

## Immediate wake 与既有 daemon 自动恢复

生产 receive 默认使用 installed NativeWakeAdapter，或使用构造/调用处注入的 adapter；**接收事务 FULL/WAL commit 后立即尝试 wake**。test ledger 默认只排队，拒绝 live adapter。ACK 只 durable-received，不是 review/accepted；可选 wake/wakeError 单独报告唤醒状态。

副本 daemon 使用 `ReceiptRecoveryCollector`。它复用原 Collector 的 scheduling hooks、原 interval 和原 executor，在既有 cadence 上最多恢复 5 个 receipt + 5 个 wake；没有新 thread pool、timer、service、port，不修改父 automation-3。明确称 **recovery polling**，事件主路径仍是 immediate receive wake。原 collector 文件不修改。CLI receipt-drain 是额外手工恢复入口。

outbox/wake：I/O 前提交 sending claim/token/30 秒 lease；过期 sending -> unknown。明确 known-not-sent 可在 2/4 秒退避后重试，最多 3 次 send，之后 failed。unknown 只 read/reconcile；read 缺失/失败/不同 payload 保持 unknown，不猜测后重发。late result 用 token/status CAS，不能覆盖已恢复结论。恢复按 updatedAt 轮转，不让旧 unknown 饥饿新事件。

Native bridge 只 post_command `{app:codex,op:send,id:controller,text:safe locator,actionId:eventId}`；文本明确包含 `codex-orchestra receipt-get EVENT_ID`、task review pending、独立检查及禁止 ACK recursion。实际部署 launcher 应配置私有 state；本包直接运行的等价 CLI 是 `python3 -m orchestra --state STATE receipt-get EVENT_ID`。HTTP200/ok 不够，必须 native read 同 controller 的 user marker `[orchestra-receipt:EVENT] ` 和 turn ID。native errors 默认为 unknown，仅 explicit not-sent/connect-before-send 能重试。原 native body/错误原文不持久化。最近 20 turns 已滚出 marker 时保守 unknown，交 planner 做更充分只读核对。

## 验证与移交

```sh
PYTHONPATH=output python3 -m unittest orchestra.test_receipts -v
PYTHONPATH=output python3 output/replay_sample.py
python3 output/verify_contract.py
PYTHONPATH=output python3 output/cli_smoke.py
PYTHONPATH=output python3 output/package_patch.py
```

61/61 新测试通过，最终测试运行 1.708s；19 条 CLI 通过；schema/replay 数量见 `contract-validation.log`。测试涵盖累计 first/revoke/rework、inbox wait、分离确认与验证、backlog、missing due、精确 safe shape、既有 executor 自动恢复，以及初稿所有 crash/unknown/claim/ACK/guard 案例。61 项均使用工作目录内隔离临时 ledger/fake transport；生产默认 wake 的测试在 adapter 构造处拦截，未访问真实 bridge。

回放首 receipt=0s、decision recorded=5s、first choice=10s，latency 正确为 10s；3s 快照显示尚未创建 decision 的 receipt backlog。6 个唯一决策，4 个首选样本 `[5.0,10.0,20.0,30.0]` 秒，P50=10.0、P95=30.0；累计 decided=4（含 revoked），currentlyEffective=3；knownOverdue=2、missingDueAt=2、overdue=null。public snapshots 全带 test=true，默认宿主视图排除这些记录。

环境禁止 Unix socket bind；真实 API 曾先因长路径、后因 sandbox Operation not permitted 失败。最终 API 测试使用真实 handler + 内存 HTTP，chmod 使用不 bind stub；**真实 socket 连通未证明**。本 executor 未真实 native send、未做跨 chat/真人验收；planner 已报告其独立 wake proof，整体仍需父验收，不能用 fake/DONE 替代。无 jsonschema 安装；stdlib validator 只覆盖本 schema 使用的关键字子集。


## Planner runtime compatibility follow-up

The installed Native Desktop bridge memoizes failed action IDs. Wire attempts use a new durable claim token (`orchestra_receipt_<claim_token>`), while the business event and reconciliation marker remain stable. Unknown attempts never resend. The explicit `pendingSince` public field dates the current pending cycle; original `triggeredAt` and first decision timestamps remain historical.

The original collector owns recovery on its existing executor/cadence. No independent scheduler or management port was added. Three known-not-sent attempts exhaust to visible failed; unknown native outcomes stay unknown for read-only reconciliation. Local actor IDs are trusted operator assertions; they do not prove independent review. Real parent evidence is required.

Run the package tests from contrib/codex-orchestra using `uv run --offline --no-project python -m unittest -q test_orchestra test_context test_brief test_archive_errors orchestra.test_receipts`. The replay generator remains in the task artifacts; fixture JSON explicitly marks synthetic test provenance and must never be treated as production history.

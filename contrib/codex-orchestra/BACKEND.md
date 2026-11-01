# Codex Orchestra 本地持久后端

本目录是可由总控复制到 `hapi/contrib/codex-orchestra/` 的标准库实现：SQLite 任务账本、轻量 daemon、只读进展快照和 CLI。没有第三方依赖，不调用 LLM，不开 TCP 端口，不自动创建 native Codex 工作聊天。

```
orchestra/                 Python 包
orchestra.py               CLI 入口：python3 orchestra.py --state DIR COMMAND
test_orchestra.py          unittest（临时目录，不碰真实聊天）
README.md
```

## 1. 快速开始

```bash
STATE=~/.local/state/codex-orchestra
python3 orchestra.py --state "$STATE" import-markdown \
  /Users/zhuhe/Documents/Codex/2026-11-01/new-chat/outputs/任务总览.md
python3 orchestra.py --state "$STATE" observe-once
python3 orchestra.py --state "$STATE" snapshot
python3 orchestra.py --state "$STATE" serve --socket "$STATE/orchestra.sock"
# 另一个终端只读查看
curl --unix-socket "$STATE/orchestra.sock" http://localhost/snapshot
```

`serve` 同时在后台每 5 秒读取已登记、未归档的任务；`observe-once` 是一次性有界并行采集。daemon 与 CLI 都使用 WAL + busy_timeout + 短事务，CLI 不会被慢采集阻塞。

## 2. 状态与权限

- `$STATE/` 权限 `0700`；`orchestra.db`、WAL 文件、daemon pid/lock、Unix socket 均为 `0600`。
- `orchestra.db` 是唯一结构化事实源；`export-md` 只是显式输出派生表，默认拒绝覆盖已有文件，且永远不会写回导入源 Markdown。
- `daemon.lock` 用 `flock` 保证单例；进程退出后 OS 自动释放。重启时新 daemon 会清理陈旧的同路径 socket，再绑定；数据库中的游标、notice、验收/归档状态保留。
- 只有 Unix stream socket，没有 TCP 监听。HTTP 端点只读：`GET /snapshot`、`GET /health`；`POST/PUT/PATCH/DELETE` 返回 405。

## 3. 真实 native 读取协议

只读取已登记到任务账本的聊天，使用现有 bridge：

```json
POST /command
{"app":"codex","op":"read","id":"<threadId>","limit":2}
```

- socket：`/Users/zhuhe/.local/state/native-desktop-bridge/host.sock`（可用 `--socket` 覆盖）。
- 连接/读取超时 3 秒；每任务一个 future，最多 4 个 worker；future 完成即写账本。
- 只持久化 latest turn 的 `id/status`、`revision`、通用 tool 状态，以及最新 assistant `commentary/final` 文本（最多 1200 字符）。
- **不会持久化** user/tool/output/reasoning 原文；`latestAction` 只可能是 `tool:completed` 这类通用状态或 `assistant:commentary`，不含命令文本。
- 真实 bridge response 没有 turn 时间戳，因此没有 native `sourceAt`；实时记录的 `observedAt` 是本次读取开始时间。`sourceAt` 只在导入/显式回调提供时出现（导入时是源文件 mtime）。
- `live=false`/`status=notLoaded` 只表示当前没有 live owner，**不等于失败或完成**：
  - latest turn 显式 `completed` → `reported` + `awaiting`（仍不是 accepted）；
  - 显式 `failed` → `failed`；显式 `interrupted` → `interrupted`；
  - `live=false` 且 latest turn 仍是 `inProgress` 或状态缺失 → `unknown`/stale，不会冒充完成；
  - 未知状态不会覆盖已经记录的 `reported` delivery。
- 回调用读取开始时间排序。较早开始但较晚返回的并发回调会被忽略；`revision`/turn id 与 `observedAt` 一起保留。
- 采集异常保留最后已知状态，只写 `last_error` 和 stale 标记；不会改 execution/review/archive。

## 4. 导入语义（任务总览）

`import-markdown FILE` 只读该文件，不修改源：

- 主表 T001–T008 导入到 `tasks`；`T001/2/3/6/7` = `reported/accepted/archived`，不轮询；`T004/5` = `queued`、无 thread、`poll=0`（历史上从未创建，不因导入而创建）；`T008` = 绑定 `01a19807-55f8-7561-865b-78f387a5aad7`、`running`，由 daemon 轮询。
- 主表 `sourceAt` 使用源文件 **mtime**（导入快照 provenance），不是 11 月 1 日 13:27。T007/T008 属于 11 月 2 日，导入不会把它们倒填到旧时间；`createdAt` 使用 import 的 `importedAt`，因为原表没有创建时间。
- `T004/5` 和 `T008` 的 `observedAt=null`，等待真实读取；已验收归档行可保留导入快照时间，但只作为历史快照，不当成当前 native 观察。
- `## 既有任务跟踪` 表进入独立 `external_history` 表，只读、`external=true`、`stale=true`，来源时间固定 `2026-11-01T13:27:00+08:00`，不轮询、不参与 review/archive/dispatch。
- 重复导入按 task id 幂等：已存在任务行不覆盖状态；外部历史记录作为只读快照刷新。
- 导入源路径和 SHA-256 记录在 meta，便于审计。

## 5. CLI

所有命令：

```bash
python3 orchestra.py --state DIR register --json FILE
python3 orchestra.py --state DIR import-markdown FILE
python3 orchestra.py --state DIR update-contract TASK --json FILE
python3 orchestra.py --state DIR dispatch-intent TASK --op-id ID
python3 orchestra.py --state DIR dispatch-pending TASK --op-id ID --client-thread ID
python3 orchestra.py --state DIR bind TASK --op-id ID --thread ID [--host local]
python3 orchestra.py --state DIR observe-once [--socket SOCK]
python3 orchestra.py --state DIR context TASK [--full | --ref KIND:INDEX --revision HASH]
python3 orchestra.py --state DIR history TASK [--limit 20] [--before ISO]
python3 orchestra.py --state DIR snapshot
python3 orchestra.py --state DIR export-md FILE [--force]
python3 orchestra.py --state DIR review TASK --result accepted|rejected --evidence TEXT --op-id ID
python3 orchestra.py --state DIR archive-request TASK --op-id ID
python3 orchestra.py --state DIR archive-receipt TASK --op-id ID --result confirmed|failed|unknown --evidence TEXT
python3 orchestra.py --state DIR archive-run TASK --op-id ID [--socket SOCK]
python3 orchestra.py --state DIR consume
python3 orchestra.py --state DIR ack NOTICE_ID
python3 orchestra.py --state DIR serve --socket PATH [--bridge-socket SOCK] [--interval 5] [--workers 4] [--enable-archive-run]
```

约定：

- `register` 接受完整字段；同 id 再次注册返回已有任务，不意外改绑；thread 冲突直接拒绝。
- `dispatch-intent` 只落盘 intent，不创建 native 聊天。已有 pending intent 或已绑定任务时返回已有 identity，拒绝重复新派发。
- `dispatch-pending` 在 create 结果尚未确定时记录 `clientThreadId`；重启后它仍是 pending 证据，只能显式 `bind` reconcile，不能因为 pending 就再 create。
- `bind` 只接受 `host=local`，记录真实 create receipt；同一任务改绑到不同 thread 会被拒绝。
- `update-contract` 只允许 `title/goal/deliverables/acceptance/ownership/authorization/checkpoint/expectedAt/evidence`，id/thread/execution/review/archive/host 等不可改。
- `review accepted` 要求真实 `execution=reported` 与明确 `delivery_turn_id`，评审绑定该交付回合。同一被审回合重复读取保留判断；同原聊天的新回合进入 running/pending，完成后 reported/awaiting，旧验收不能授权新阶段归档。只有 archived 是回调不能重开的终态。合同修订、交付与评审历史追加保存。
- `archive-request` 只允许 accepted + 非 external + 已知 thread，且幂等；它**不调用 native**，只留下 pending 操作。
- `archive-receipt` 是人工/外部工具执行归档后的回执；`failed` 保留可重试，`unknown` 需先对账。
- `consume` 只返回未确认的 delivery/blocked notice；`ack` 单独确认，重启不重复投递。
- `export-md` 仅生成显式指定路径；默认不覆盖已有文件；拒绝与导入源同一路径。

## 6. 安全归档 archive-run（可选 daemon）

`archive-run` 只处理已经显式 `archive-request` 的 accepted 任务：

1. 先调用 bridge 只读 `{"op":"list","archived":true}`（带 cursor 分页）；若目标已在归档列表，直接登记 archived，不再写。
2. 否则把 operation 持久化为 `attempting`（attempt 计数 +1），然后**恰好一次** POST：
   `{"app":"codex","op":"archive","id":threadId,"archived":true,"actionId":"orchestra-<op>-a<n>"}`。
3. `ok=true` 且 `archived=true` → confirmed，任务 `archive=archived`。
4. 超时/结果不明 → `archive=unknown`，后续只做 list reconcile，**绝不重复写**；崩溃遗留的 `attempting` 同样只对账。
5. bridge 明确 `delivery=not-sent` 或 native rejected → `archive=pending` + operation `retry`，最多 3 次；第 4 次拒绝。
6. controller thread 永久拒绝归档；T008 在 parent 记录 accepted review 前拒绝，accepted 后允许 parent 归档，不再是永久硬编码拒绝。

daemon 默认**不**执行归档；显式加 `serve --enable-archive-run` 才会处理 pending archive ops。人工路径始终保留：外部工具归档后用 `archive-receipt` 登记。

## 7. 恢复与停止

```bash
# 启动（前台；生产可交给现有进程管理，勿新建 cron/automation）
python3 orchestra.py --state "$STATE" serve --socket "$STATE/orchestra.sock"

# 停止：向该进程发 SIGTERM/SIGINT；锁和 socket 会被清理
kill -TERM <pid>
```

- 单例冲突：第二个 `serve` 返回非零并报 `another orchestra daemon already holds ...`，不会抢锁。
- 若进程被杀，`flock` 随进程释放；下次 `serve` 会探测旧 socket，连接不上就删除并重新 bind。数据库是 WAL，已有未确认 notice、operation、游标不会丢。
- 采集断开时 `collector.taskErrors` / `lastError` 可见，任务 `stale=true`，最后已知状态保留；恢复读取后自动清除 error。
- 如果 socket 仍被一个健康进程占用，不会被强删；先确认哪个进程持有 `daemon.lock`。

## 8. `/snapshot` 契约

```json
{
  "version": 1,
  "generatedAt": "ISO-8601",
  "controllerThreadId": "01a19339-39e6-7081-8920-82db9992402a",
  "collector": {
    "source": "native-desktop-bridge", "pollIntervalSeconds": 5.0, "workerCount": 4,
    "running": true, "connected": true, "stale": false, "pid": 123,
    "startedAt": "...", "lastPollAt": "...", "lastSuccessAt": "...",
    "lastObservedAt": "...", "inFlight": 0, "lastError": null,
    "taskErrors": {"T008": "..."}
  },
  "tasks": [{
    "id": "T008", "title": "...", "goal": "...",
    "deliverables": [], "acceptance": [], "ownership": [],
    "authorization": "...", "threadId": "...", "host": "local",
    "createdAt": "...", "checkpoint": "...", "expectedAt": null,
    "execution": "running", "review": "pending", "archive": "none",
    "observedAt": "...", "sourceAt": null, "progress": "...",
    "latestAction": "tool:completed", "evidence": [],
    "stale": false, "attention": false, "external": false
  }],
  "notices": [],
  "operations": []
}
```

`operations` 最多 50 条；`notices` 最多 50 条未确认通知。`stale` 由 `observedAt` 超过 30 秒、存在采集 error 或 external 只读记录决定；`attention` 突出 `review=awaiting`、failed/interrupted/blocked、以及 stale 的 running/unknown。

`collector.connected` 仅在 daemon 进程存活且 `lastPollAt` 不超过 30 秒时为 true；`collector.stale` 在未连接、任一活动轮询任务有 error，或其 `observedAt` 为空/超过 30 秒时为 true。`lastSuccessAt` 是所有非 external、无 error、未归档任务中最新的成功 `observedAt`；`lastObservedAt` 是所有非 external 任务最新的 `observedAt`（没有任务记录时退回 `lastPollAt`）。公开快照只暴露 source 标签 `native-desktop-bridge`，不暴露 raw bridge socket 路径。

## 9. 测试与已验证证据

```bash
python3 -m unittest -v test_orchestra.py
# 20 tests, OK
```

覆盖：导入语义与时间戳、completed→awaiting、live=false 的 archived completed、failure/inProgress 无 owner 不完成、disconnect stale、乱序回调忽略、同turn验收保持、新turn续查重新待验收、archived不被回调重开、per-turn notice 去重与重启、重复 opId、慢 worker/并发注册/超过 worker 数的公平调度、snapshot 不含 user/tool/reasoning、external 只读拒绝、Unix socket 0600/目录 0700/只读 405、`archive-run` 单次写/已有归档对账/unknown 不重试/not-sent 三次上限。

实测（2026-11-02，本机）：

- 真实 bridge 读取 T008：HTTP 200，约 0.003–0.08 秒；`observe-once` 1 个任务，0 errors；T008 进入 `running`。
- 真实 daemon：Unix socket `srw-------`，`GET /snapshot` 200，`POST` 405，第二个 daemon 被 flock 拒绝；SIGTERM 后 socket 清理，重启后再次 200。
- 真实 archive list 只读对账：T008 `archived=false`，约 0.3 秒；未执行任何 archive 写。
- 导入真实 `任务总览.md`：8 个主任务 + 5 条 external；源文件未被修改。

## 10. 已知限制

- 本包只做本机 Unix socket + SQLite；没有网页前端，`/snapshot` 供现有 HAPI/Desktop 认证层消费。
- native bridge 没有提供 turn 时间戳，实时 `sourceAt` 为 null；`observedAt` 是读取时间，不是模型完成时间。
- daemon 只更新账本和 Unix 快照，不唤醒总控模型；需要总控轮询/消费 notice。
- `archive-run` 依赖 bridge 的 `list archived` 支持；list 失败时为保证不重复写会拒绝 mutation。
- 未做真实 native archive 写验证（避免归档 T008/controller）；`archive-run` 用注入 client 的单元测试覆盖一次写、unknown 只对账和次数上限。真实执行由 planner 在验收后决定。
- `register` 不推断 execution；调用方必须按真实状态给出枚举值。

## 9. 有界召回与历史

`context TASK` 仅投影已有字段为小上下文，带原task/thread身份、观测时间、完整合同/历史/精确证据引用的召回命令。`--ref KIND:INDEX --revision HASH` 在合同变化时拒绝旧引用；不读取引用文件，不调用模型，不触发原生context压缩。完整授权有截断时须显式`--full`核对。

`history TASK` 按任务召回追加历史；默认20条、最大100条，`--before ISO`查更早记录。五秒快照只带最近20条历史索引，不携带完整旧合同或无界reviewed turn列表。旧版本未记录过的完整合同修订无法事后补造。迁移仅依据终态、评审时间和持久交付证据绑定旧评审；不明确时保留旧证据而不编造回合。

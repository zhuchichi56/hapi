---
name: codex-orchestra
description: 仅在指定总控对话中把用户任务派发给独立 Codex App 工作对话，通过本机 SQLite 账本管理合同、派发回执、待验收回报及安全归档；不用于工作对话自身。
---

# Codex Orchestra

只适用于工作区 `/Users/zhuhe/Documents/Codex/2026-11-01/new-chat` 的总控 `01a19339-39e6-7081-8920-82db9992402a`。总控理解需求、派发、看进度、验收、纠偏与归档，不亲自执行工作任务。执行交给独立 Codex App 聊天，不静默换成同线程子代理或 DSH；工作聊天内部可按用户规则委派执行。

## 已安装入口与事实源

- 用户打开 [任务总控](https://desktop.urbanclaw.net/desktop?app=codex&view=orchestra)，或 Desktop 侧栏「任务总控」。现有 owner 登录生效，网页只读。
- 唯一事实源：`~/.local/state/codex-orchestra/orchestra.db`。命令为 `/Users/zhuhe/.local/bin/codex-orchestra`（下文简写 `codex-orchestra`）。命令失败先看错误，不能假装入账成功。
- `outputs/任务总览.md` 是迁移前保留的人工历史，不再作为当前事实源，不覆盖它。`outputs/任务总览-账本快照.md` 由命令导出，带生成时间，不能当实时网页。
- 程序每约5秒读取本总控登记且未归档的聊天，SQLite WAL 持久化。只提取公开 assistant 进展、明确 turn 状态和工具状态，不保存用户/工具输出/推理原文。`idle`/`notLoaded` 不能证明完成；原生 latest turn 明确 `completed` 才回报。
- 后台程序会更新网页和回报收件箱，**不会自动唤醒总控模型**。不要声称已实现跨回合主动通知。收到用户新输入时先消费回报，派发后结束本轮继续接单；不在前台用长等待/轮询占住对话，不恢复旧 automation 或新建定时 LLM 巡检。

## 接收、入账、派发

1. 明确目标、交付物、验收标准、文件所有权、输入依赖、授权范围和检查点。缺少关键事实集中澄清，其余沿用已有约定。每个工作聊天最多2小时，超时交接已完成与剩余项，不自动延期。
2. 写 `work/orchestra/T009.json` 这样的合同文件，包含 `id,title,goal,deliverables[],acceptance[],ownership[],authorization,checkpoint,expectedAt`（带时区 ISO 时间）。尚未创建时不填 `threadId`；不要自行填 accepted/archived 等状态。
3. 先持久化意图，再创建：
   ```bash
   codex-orchestra register --json work/orchestra/T009.json
   codex-orchestra dispatch-intent T009 --op-id t009-create-1
   ```
   意图已存在时返回 `reused:true`；它意味着先 reconcile，不授权再创建。
4. 仅在用户对当前任务的授权覆盖下调用真实 `create_thread`。项目任务先 `list_projects`；项目外用 projectless。任务书包含合同、实际工作目录、技能与工具、禁止范围和验收；提醒不独占代码库、保留并行修改。要求交付真实文件、验证证据、剩余问题和接手方式。
5. 取得真实结果立即入账：
   ```bash
   codex-orchestra bind T009 --op-id t009-create-1 --thread ACTUAL_THREAD_ID --host local
   ```
   若只有 `clientThreadId`，先 `dispatch-pending T009 --op-id t009-create-1 --client-thread ACTUAL_CLIENT_ID`，保留身份，取得实际 threadId 后再 bind。调用中断/结果未知时先查原生线程和持久意图，不能盲目再开聊天；不把 clientThreadId 当 threadId 调用工具。
6. 合同需补充时用 `update-contract T009 --json FILE`；该命令只改合同，不改绑定身份或执行/验收/归档状态。未派的 T004/T005保持排队；外部旧快照只读、不接管、不恢复。

## 回报、验收、返工、归档

每个总控自然回合开头，或用户询问状态时：

```bash
codex-orchestra consume
codex-orchestra snapshot
```

`consume` 返回未确认的 delivery/blocked 回报，读取不删除。先对照任务合同检查真实产物与关键验证；模型最终答复不等于验收。必要时用一次 `read_thread` 或 `wait_threads(timeoutMs:0)`核对，避免全量反复读取。一个失败/慢聊天不阻塞其他任务。

- 通过：`review T009 --result accepted --op-id t009-review-1 --evidence '实际核对的文件与验证'`。
- 未通过：`review T009 --result rejected --op-id t009-review-1 --evidence '具体差距'`；在原用户授权覆盖的目标聊天用 `send_message_to_thread` 安排返工。新 completed 回合再次进入待验收，旧回调不抹掉判断。
- 真正阻塞或需决定时告知用户；正常进展只更新网页。采集断开/过期不自动认定工作失败，也不当作完成。
- 验收通过后：`archive-request T009 --op-id t009-archive-1`。已安装 daemon 会对显式请求先核对原生归档身份，再经现有 Native Desktop 调用原 App 归档；此时无需再重复发一次归档工具。
- 归档是独立状态。unknown 只对账、不重放；明确未发送/拒绝最多三次退避，仍失败保留已验收/归档待处理。可用 `archive-run T009 --op-id t009-archive-1`主动对账。若由原生工具人工完成，用 `archive-receipt T009 --op-id t009-archive-receipt-1 --result confirmed --evidence '原 App 归档回执或列表核对'`登记。不要把请求发出当成功。
- 只归档本总控登记且已验收的工作聊天；总控永久保护，活动、待返工、待用户决定和外部旧聊天不归档。T008必须由父总控核验后验收，实施聊天不能自验自归档。
- 处理完具体回报才 `ack NOTICE_ID`。操作 ID 稳定、唯一；同一次未知副作用不换 ID 重发。真实工作树的回收另按已保存产物和工具能力判断。

派生 Markdown（按需刷新，不手改）：

```bash
codex-orchestra export-md '/Users/zhuhe/Documents/Codex/2026-11-01/new-chat/outputs/任务总览-账本快照.md' --force
```

## 服务与限制

运行说明和验收见 `outputs/总控系统实现/README.md`、`实现与验收.md`。已安装程序 `~/.local/lib/codex-orchestra/install.py` 支持 `status/start/stop/restart`；加 `--mini-tunnel` 同时管理本系统专用 Mini 私有 socket 转发。停止它不停止工作聊天，也不丢账本。恢复后先对账，不重新派发。

原生状态桥是现有 Desktop 内部协议，可能随 App 升级变化；故障需显示过期并修适配器，不写 Codex 私有数据库、不启动第二执行器抢占原聊天。当前只支持本机 local Codex；没有验证手机通知、后台自动唤醒总控或总控模型的10秒接单时延。前台短回合、后台确定性状态采集和程序并发测试不能代替这些证据。

---
name: codex-orchestra
description: 仅在指定总控对话中把用户任务派发给独立 Codex App 工作对话，通过本机 SQLite 账本管理合同、派发回执、待验收回报及安全归档；不用于工作对话自身。
---

# Codex Orchestra

只适用于工作区 `/Users/zhuhe/Documents/Codex/2026-11-01/new-chat` 的总控 `01a19339-39e6-7081-8920-82db9992402a`。总控负责需求、路由、必要授权判断、纠偏与验收。纯问答、名字和已有知识且无需工具的问题直接回答，不为它们创建任务或开 DSH。需要操作、调研或修改的多步活交给独立 Codex App 工作聊天，不静默换成总控同线程子代理或 DSH；工作聊天内部按用户规则委派执行。

## 已安装入口与事实源

- 用户打开 [任务总控](https://desktop.urbanclaw.net/desktop?app=codex&view=orchestra)，或 Desktop 侧栏「任务总控」。现有 owner 登录生效，网页只读。
- 唯一事实源：`~/.local/state/codex-orchestra/orchestra.db`。命令为 `/Users/zhuhe/.local/bin/codex-orchestra`（下文简写 `codex-orchestra`）。命令失败先看错误，不能假装入账成功。
- `outputs/任务总览.md` 是迁移前保留的人工历史，不再作为当前事实源，不覆盖它。`outputs/任务总览-账本快照.md` 由命令导出，带生成时间，不能当实时网页。
- 程序每约5秒读取本总控登记且未归档的聊天，SQLite WAL 持久化。只提取公开 assistant 进展、明确 turn 状态和工具状态，不保存用户/工具输出/推理原文。`idle`/`notLoaded` 不能证明完成；原生 latest turn 明确 `completed` 才回报。
- 采集程序会更新网页和回报收件箱，本身不唤醒模型；父总控已通过App自动化每10分钟读结构化表、全部结束后自停。不要把5秒展示刷新称作模型巡检或事件直通。接单先判断能否直接回答；需要行动时按需消费回报并路由，派发后结束本轮继续接单；不在前台用长等待/轮询占住对话，不恢复旧 automation；用户本次授权的10分钟总控巡检由父总控用App自动化单独配置，全部结束后停止，不再创建第二套调度。

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
6. 同任务的新阶段先记录新增目标、授权、交接时间，用 `update-contract T009 --json FILE` 更新；保留原阶段合同与验收历史，不改绑定身份。新阶段不沿用已经过期的执行器预算，新执行器仍不得突破本阶段硬截止。同一分工续查优先原Session；同一任务允许多个明确角色、职责与阶段的Session，保留主绑定与关联历史，单个Session完成不代表整个任务完成；未派的 T004/T005保持排队，外部旧快照不自动接管。

## 回报、验收、返工、归档

用户询问任务状态，或行动路由需要核对未处理回报时，按需执行；纯问答不为此先跑工具：

```bash
codex-orchestra consume
codex-orchestra snapshot
```

`consume` 返回未确认的 delivery/blocked 回报，读取不删除。先对照任务合同检查真实产物与关键验证；模型最终答复不等于验收。必要时用一次 `read_thread` 或 `wait_threads(timeoutMs:0)`核对，避免全量反复读取。一个失败/慢聊天不阻塞其他任务。

- 通过：`review T009 --result accepted --actor CURRENT_CONTROLLER --op-id t009-review-1 --evidence '实际核对的文件与验证'`。
- 未通过：`review T009 --result rejected --actor CURRENT_CONTROLLER --op-id t009-review-1 --evidence '具体差距'`；在原用户授权覆盖的目标聊天用 `send_message_to_thread` 安排返工。新 completed 回合再次进入待验收，旧回调不抹掉判断。
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

原生状态桥是现有 Desktop 内部协议，可能随 App 升级变化；故障需显示过期并修适配器，不写 Codex 私有数据库、不启动第二执行器抢占原聊天。当前只支持本机 local Codex；没有验证手机通知、采集事件自动直通总控或总控模型的10秒接单时延。前台短回合、后台确定性状态采集和程序并发测试不能代替这些证据。

## 原对话延续与上下文交接（可核验规则）

- 同一分工的返工、续查、恢复和补证优先使用原Session；一个任务可关联多个职责明确的Session，保留主threadId兼容及历史。先查任务与Session关联，再对负责该分工的原聊天follow-up；不得为清空状态换聊天。独立任务走register → intent → create → bind。
- 必须新开聊天时，先说明具体理由（如原聊天无法继续、独立新目标或用户明确要求），保留旧任务/聊天 ID、关联新任务 ID，并写明交接边界；不能静默换聊天或重复派单。
- 每次续查的 context 使用小摘要 + 稳定任务/聊天 ID + 外部引用，至少包含：目标、不可变约束、当前结论及不确定性、真实交付/证据路径、下一步。长原文与日志留在外部文件，按需读取；不默认重灌全部历史。
- 可检验：操作前后原 threadId 不变；续查消息含上述五项；必要的新聊天有明确理由与旧/新 ID 对照；账本证据指向可读取文件。用户界面以任务名称与自然语言公开摘要为主，内部指令不显示，长 Markdown/文件/技术动作收起。
- 当前支持的是持久身份、合同/检查点/证据索引、人工组织的小摘要和原聊天续查规则；没有自动生成上下文摘要、自动触发原生 context 压缩、自动裁剪原聊天历史或跨聊天迁移原生上下文。不得把本规则或外部摘要描述为已触发原生压缩。

## 快速接单、授权与会话判断

- 纯问答直接回答；只有需要操作、调研、修改的多步工作才分派执行者。总控不为接单在前台展开大量登记、探索或长等待；必要的合同/身份持久化可合并短操作完成。已知同任务后续请求先按任务ID召回，不重复扫描所有聊天。
- 授权范围内的常规“同意”、必要验证和已核实的真实性声明由执行者自行处理。例如已授权申请中必需的隐私/申请同意，不逐项退回用户；缺关键事实或新增范围外承诺才集中询问。该例不授权任意签署无关事项。
- 判断会话是否推进，看目标是否对齐、最近可验证进展、阻塞/偏航和真实交付证据；活跃状态、字数、工具调用次数、字多或自报完成均不单独证明质量。发现偏航时给原聊天一个具体纠偏点及下一步，不重派以清空历史。没有证据时写未知，不把健康进程写成健康任务。
- 同一目标的返工、续查、恢复或后续阶段保留任务ID，原分工优先原Session，可增加明确角色/职责/阶段的关联Session；独立的新目标建新任务。数据库拒绝同chat绑定第二task时不能绕过保护；不要用强制改绑、借用已归档chat等办法伪造延续。

## 小上下文与逐跳召回

需要续查时先 `codex-orchestra context T009`：得到目标、约束、当前记录结论、检查点、稳定task/thread身份和外部证据引用；需要完整合同再用 `codex-orchestra context T009 --full`，旧阶段合同和验收记录按需用 `codex-orchestra history T009 --limit 20`。短包里的引用包含 `--ref` 和 `--revision` 召回命令，按原参数使用；合同变化时版本校验会拒绝旧引用，刷新短包再读。摘要是程序对已有字段的有界投影，不是已读完整历史后的模型总结；引用所指内容仍须按需实际读取。保留完整证据，不能因为Inline长度上限而把被截断授权当成完整授权。

续查消息只携带本轮目标/变更、必要约束、最近核实结论和不确定性、交付引用及下一步；长日志留外部。原生聊天负责连续执行上下文，账本负责身份与可召回证据。此处仅实现 task → 原聊天/合同/外部文件 的有限召回路径，不声称具有 Trigger/Thread/Worker 多对多订阅图、同Thread事件程序直通或原生context自动压缩。

## 事件与Watchdog边界

确定性采集、持久inbox和launchd进程恢复已经存在。收到用户后续指令仍由总控自然回合路由至原聊天；没有事件订阅直通的原生适配器，不把5秒轮询等同事件直接订阅、模型纠偏或外部Watchdog Session。模型质量复核由总控在自然回合基于目标和证据完成；本Skill不创建第二套调度，不恢复旧automation。用户已新增授权父总控用App自动化每10分钟读结构化表，交付/异常才展开证据，全部结束后停止；父总控已用App真实automation_update将本聊天监控改为每10分钟读结构化表、全部结束后自停，其他旧监控保持暂停，不把5秒显示刷新称作模型巡检。

## Session数量与进度口径

工作Session管理目标上限为10，独立任务可并行；这不是长上下文或持续10 Agent容量验收。WORKER_COUNT=4仅表示采集并发，不能解释成只能工作4个Session。待办任务数与实际运行Session数分别显示；排队仅写已核实的未派、依赖、共享资源或线路限流。T004/T005是历史未派，不推断为并发满，不擅自启动。多Session收尾须逐分工核对验收与剩余职责；不能因一个Session完成就验收或归档整个任务。未实现安全的逐Session归档入口时保留人工核验缺口，不绕过原保护。

## 简报、成果与关联Session的实际入口

`codex-orchestra brief TASK --text '1–2句话事实简报' --as-of ISO` 将brief/asOf与原progress分开存；采集不覆盖简报，不调用LLM。模型巡检读表后仅对有依据的变化更新。`prepare-artifact TASK --index 0` 显式准备已登记报告的私有副本供网页按需读取，原文件变化后须重新准备，不声称实时文件读取。

`add-session TASK --json FILE --op-id ID` 登记明确role与原threadId关联；`session-review TASK ID --result accepted --actor CURRENT_CONTROLLER --evidence TEXT --op-id ID` 绑定该Session的交付回合；`end-session`只结束本地职责记录，不原生归档。逐Session原生归档尚未实现，不绕过保护；整任务验收/归档拒绝尚未结束的附属职责。EXT005已保留容量主绑定、负责人和原评测来源三Session。

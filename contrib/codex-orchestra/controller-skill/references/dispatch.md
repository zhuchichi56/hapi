# 派发:登记、创建、续查

仅在需要新开或续派工作聊天时读。纯问答不走这里。

## 1. 合同

任务书开头三句:要得到什么和保留什么 / 先解决哪个具体缺口及原因 / 交什么可见结果才算完成。其后按需列验收、文件所有权(`ownership`)、依赖、授权、检查点。最新纠正替换冲突命令,旧正文只留历史引用。缺关键事实集中澄清一次,其余沿用已有约定。每个工作聊天最多 2 小时,超时交接已完成与剩余项,不自动延期。

写 `work/orchestra/T009.json`:`id,title,goal,deliverables[],acceptance[],ownership[],authorization,checkpoint,expectedAt`(带时区 ISO 时间)。创建前不填 `threadId`;不自行填 accepted/archived 等状态。**派发前先查 `ownership` 与活跃任务是否重叠**(SKILL §三·1)。

## 2. 先记意图,再创建

```bash
codex-orchestra register --json work/orchestra/T009.json
codex-orchestra dispatch-intent T009 --op-id t009-create-1
```

意图已存在时返回 `reused:true`,表示先对账,不授权再创建。

## 3. 创建聊天

- 仅在用户对当前任务的授权覆盖下调用真实 `create_thread`。项目任务先 `list_projects`;项目外用 projectless。任务书写明合同、实际工作目录、技能与工具、禁止范围、验收;提醒"不独占代码库、保留并行修改";要求交付真实文件、验证证据、剩余问题、接手方式。
- **权限**:`create_thread` 参数不支持权限配置,新聊天首轮可能默认 workspace/on-request。先用不调用工具的简短就绪轮创建,再用 App 支持的 thread settings 接口设为 Full Access + never;正式任务从下一轮启动,并**读回 currentPermissions 确认**。设置成功或 nextSettings 不能冒充当前生效;不代答必须本人确认的审批。

## 4. 立即入账

```bash
codex-orchestra bind T009 --op-id t009-create-1 --thread ACTUAL_THREAD_ID --host local
```

只有 `clientThreadId` 时,先 `dispatch-pending T009 --op-id t009-create-1 --client-thread ACTUAL_CLIENT_ID` 保留身份,取得真实 threadId 后再 bind。调用中断、结果未知时先查原生线程和持久意图,不盲目再开聊天;不把 clientThreadId 当 threadId 调工具。

## 5. 新阶段、续查、换聊天

- 同任务新阶段:先 `update-contract T009 --json FILE` 记录新增目标、授权、交接时间;保留原阶段合同与验收历史,不改绑定身份;不沿用已过期的执行器预算,新执行器仍受本阶段硬截止约束。
- 返工、续查、恢复、补证优先原 Session。一个任务可有多个职责明确的 Session(`add-session TASK --json FILE --op-id ID`),单个 Session 完成不代表整个任务完成。数据库拒绝同聊天绑定第二个任务时不能绕过(不强制改绑、不借用已归档聊天)。
- 必须新开聊天时,先说明具体理由(原聊天无法继续 / 独立新目标 / 用户明确要求),保留旧任务与聊天 ID,关联新任务 ID,写明交接边界;不静默换聊天、不重复派单。
- 同一 Agent 不堆积超过 3 个独立任务,第 4 项起交给其他 Agent 并行。内部并行修复按模块与文件所有权拆分,共享文件保持单一写者,Root 负责集成与最终核验。

## 6. 小上下文召回

续查先 `codex-orchestra context T009`:得到目标、约束、当前记录结论、检查点、稳定 task/thread 身份和外部证据引用;需要完整合同加 `--full`;旧阶段合同和验收记录用 `codex-orchestra history T009 --limit 20`。短包里的引用带 `--ref` 与 `--revision`,按原参数使用;合同变化时旧引用会被拒绝,刷新短包再读。摘要是程序对已有字段的有界投影,不是模型总结;引用所指内容仍要按需实际读取,不把被截断的授权当完整授权。

续查消息只带五项:目标/变更、不可变约束、最近核实的结论与不确定性、交付与证据路径、下一步。长日志留外部文件。原生聊天负责连续执行上下文,账本负责身份与可召回证据;不声称已自动压缩或迁移原生上下文。

## 7. 执行者与模型

简单明确的执行默认 DSH + DeepSeek V4.1 Flash;复杂设计、多约束实现、疑难排障用 Codex CLI + GPT-6.1 Sol。用户指定时按用户指定;沿用 `dsh-delegate` 的真实入口并核对执行器,不只在文案里写模型;冻结实验不换身份。受阻时先判断并在现有授权内排障、修接入或换可行实现,只有确需本人操作或缺关键授权才交给用户。

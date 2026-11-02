# 项目目录与项目树

项目目录作为私有 sidecar 接入现有只读快照；`server.py` 仅包装 snapshot、附加已准备成果索引并保存 state_dir。不替换主 CLI、不增加 Web 写接口。现有 owner-only 路由与授权方式继续使用。

在 `contrib/codex-orchestra` 下运行（`PRIVATE_DIR` 由操作者设置为既有私有目录）：

```sh
python -m orchestra.projects --state "$PRIVATE_DIR" init
python -m orchestra.projects --state "$PRIVATE_DIR" catalog
python -m orchestra.projects --state "$PRIVATE_DIR" catalog --json explicit-projects.json
python -m orchestra.projects --state "$PRIVATE_DIR" import-index synthetic-index.json
python -m orchestra.projects --state "$PRIVATE_DIR" assign --thread synthetic-thread --project deepswe --direction evaluation --evidence 'Explicit synthetic mapping'
python -m orchestra.projects --state "$PRIVATE_DIR" assign-task --task synthetic-task --project deepswe --direction evaluation --evidence 'Explicit synthetic task mapping'
python -m orchestra.projects --state "$PRIVATE_DIR" apply --json explicit-assignments.json
```

`init` 幂等添加通用分类：UrbanClaw（ToB/ToC/城市规划图/技术博客）、Learning from Deployment（通用）、DeepSWE（评测/RSI/推理部署与测速）、Personal Agent（私人看板/开源版）、开发工具（HAPI/总控界面）、杂项。实际 ID 见 `catalog`；Learning from Deployment 与 DeepSWE 独立。新增 paper-learning/careers/toefl/resource-ops 等项目必须显式提供分类，名称不触发自动归属。

仅新增 `project-catalog.json` 与 `.project-catalog.lock`，均为 0600。写入在独占 flock 内做临时文件、fsync、原子替换；原目录权限和杂项状态文件均不修改。失败不会替换原目录文件。导入保留已有未知元数据，合并同 ID 分类/方向/线程；手工 assignment 优先。导入来源与历次归属证据保存在内部 `_sources` / `_importEvidence`，手工记录带 `_manual:true`；这些内部字段不发到浏览器。重复同一导入不改变 asOf 或文件内容。未提供某线程不代表删除或归档。

`catalog --json` 和 `import-index` 使用同一显式对象格式，可省略空字段，禁止关键词分类：

```json
{
  "version": 1,
  "projects": [{"id":"paper-learning","name":"Paper learning","directions":[{"id":"reading","name":"Reading"}]}],
  "threads": [{"id":"synthetic-thread","title":"Synthetic indexed chat","updatedAt":1700000000000,"archived":false,"source":"synthetic-export","projectId":"paper-learning","summary":"Synthetic summary"}],
  "assignments": {"synthetic-thread":{"projectId":"paper-learning","directionId":"reading","evidence":"Explicit synthetic source metadata"}},
  "taskAssignments": {}
}
```

`apply --json` 仅接受 `{assignments:{...},taskAssignments:{...}}`，其每条记录作为手工显式归属。`assign` 无需先导入对应线程；关联 task/session 后也会按同一身份匹配。所有 assignment 必须包含有效项目、该项目的有效方向与非空 evidence。线程必须有 id/title/archived/source，缺 updatedAt 变为 null；archived 严格为原生 boolean。时间接受 epoch 秒、epoch 毫秒或 ISO，统一为 UTC ISO。仅有 thread.projectId 时留在该项目“未分方向”。

业务完成声明只接受显式 `goalCompletions`，默认空数组；`catalog --json` 与 `import-index` 均可追加/更新：

```json
{
  "goalCompletions": [
    {"taskId": "synthetic-task", "reviewOpId": "review-synthetic-001",
     "goalSatisfied": true, "evidence": "Explicit whole-goal statement"}
  ]
}
```

`taskId` 为非空字符串且最多 128 字符，`reviewOpId` 非空且最多 256 字符，`evidence` 非空且最多 4096 字符；`goalSatisfied` 必须严格为 JSON boolean `true`（`1`/`"true"`/`false` 均拒绝）。仅显式声明进入目录，不从 accepted、原生成 completed 或 archive 推断。按 `(taskId, reviewOpId)` 幂等合并：重复导入不改变文件内容或 `asOf`；同键新声明覆盖已知字段，保留既有未知字段与未在本次导入中出现的旧声明。未知顶层/条目元数据继续保留。

私有 `goalCompletions`、其 evidence 和 reviewOpId 只留在磁盘目录，不进入 `snapshot.projectCatalog` 或任何 wire 字段；活动投影只发不透明 eventId。`/snapshot` 在读取私有目录后调用 `attach_activity`，仅当同一 task 的 reviewed operation 为 recorded 且 payload result 为 accepted 且存在匹配声明时才产生 completion。活动读取或目录读取失败只把 `activity` 置为 `{available:false,error:"activity_unavailable"}`，原 tasks/collector 与项目目录错误字段仍可用；不新增端点、轮询、写操作或鉴权路径。

`snapshot.projectCatalog` 的最终 wire 形状如下；`asOf` 是本地目录最后一次内容更新的时间，缺文件时为 null：

```ts
{
  version: 1,
  asOf: string | null,
  coverage: { indexed: number, emitted: number, truncated: boolean },
  projects: Array<{id: string, name: string, directions: Array<{id: string, name: string}>}>,
  assignments: Record<string, {projectId: string, directionId: string, evidence: string}>,
  taskAssignments: Record<string, {projectId: string, directionId: string, evidence: string}>,
  threads: Array<{id: string, title: string, updatedAt: string | null, archived: boolean, source: string,
                  projectId?: string, cwd?: string, summary?: string}>
}
```

缺文件返回空目录，任务进入“杂项”；损坏/不可读/超限时返回空目录及 `snapshot.projectCatalogError="catalog_unavailable_or_invalid"`，原 tasks、collector 与杂项 payload 字段保留。读取不创建目录或锁文件。磁盘输入/输出上限 2 MiB，wire catalog 上限 256 KiB（Hub 512 KiB 上限仍包含原 snapshot 的杂项数据）。wire 白名单发字段：标题最多 240 字符、来源 120、证据 256、cwd 160、summary 320；超限先去掉 cwd/summary，再从索引末尾减少线程。任何精简设置 truncated，indexed/emitted 如实显示。若仅分类/assignment 已超上限，报告目录错误而非隐藏原任务；全量数据仍在磁盘。

UI 只显示有条目的项目/方向。归属顺序：taskAssignments → task 原 threadId 的 assignment → main session 的 assignment → 杂项 session assignment → 显式 thread.projectId → 杂项。没有标题推断。任务 ID 去重；所有 task.threadId、session.threadId 和 sessionId 都从索引排除。索引行始终是“索引 · 状态未知”，原生归档另标“原生已归档”，不会生成 managed task 或证明业务完成。

已有 ledger 历史判断保持：原生 archive=archived 进历史；已验收且无新鲜关联责任执行也进历史，恢复的新鲜非主责任执行可重新进入当前。项目内历史折叠，“杂项”历史进入全局“历史”；外部历史快照仍按未接管与过期处理。搜索涵盖所有已发到浏览器的字段、折叠与历史；输入搜索会恢复“全部”筛选并展开匹配路径。关闭分支不挂载叶子 DOM；summary 使用原生键盘操作。详情开启时获得焦点，关闭返回触发按钮。保留成果只读入口与安全 Markdown 预览。

验证命令（在合入后的相应目录中）：

```sh
# contrib/codex-orchestra
python3 -m unittest discover -s tests -p 'test_projects.py' -v
python3 -m unittest discover -s tests -p 'test_activity*.py' -v
# web（使用源项目已有依赖和 Vitest 配置）
node node_modules/vitest/vitest.mjs run src/components/nativeDesktop/OrchestraBoard.test.tsx
```

主表以任务目标、具体进展、投入与结果为四栏；投入由独立统计模块提供，本轮缺少可靠阶段数据时显示未采集。详情默认只显示交付信息，完整记录在“技术记录”中折叠。

`catalog --json` / `import-index` 还接受显式业务呈现元数据（不会更改原账本）：

```json
{
  "taskPresentations": {
    "synthetic-task": {
      "title": "Measure throughput",
      "delivery": "Timing report",
      "summary": "Waiting for access",
      "summaryAt": "2026-01-01T00:00:00Z",
      "nextStep": "Verify access",
      "phaseState": "blocked",
      "phaseAt": "2026-01-01T00:00:00Z",
      "phaseEvidence": "Explicit coordinator observation"
    }
  }
}
```

`phaseState` 可省略或为 blocked/ended，必须依据明确阶段证据；UI优先保留新鲜的真实执行状态。被新简报替代的旧 presentation.summary 不再进入快照，防止固定文案掩盖后续进展。项目、方向、展示字段均可通过此显式接口维护，禁止运行时标题猜测。后续接单先复用任务身份，再调用 assign-task 归类；没有证据时放杂项。

快照每个任务可附加 `artifacts:[{index,name,preparedAt}]`，仅来自既有 `read_prepared_artifact` 的成功读取。准备成果沿用主CLI `prepare-artifact TASK --index N`，不改读取边界、不猜路径。Web仅对这些索引显示按钮，精确请求同一index的私有artifact接口；无文件/不支持格式不显示空按钮。

方向可含可选 `parentId`，显式引用同项目其他方向，支持多级子方向；导入拒绝未知父节点与循环。任务是独立节点，其下 `sessions` 展示为工作对话叶子，可包含当前接手与多个协作对话；`nativeArchived` 仅来自显式原生归档记录。旧结束/归档叶子默认折叠，单个回合完成不会令有当前接手的任务结束。项目、方向、任务和新鲜运行对话分别计数，不以索引聊天数量代表执行容量。

任务进入历史仅改变呈现，不写accepted/archived回原账本；合并建议用有证据的 `phaseState:ended` 和 summary 记录。原主会话归档而新责任会话仍在执行时，任务保持当前，原链接留在折叠历史叶子。

展示字段 `taskPresentations.<taskId>.waitingOn` 通过原 `catalog --json` / `import-index` 合并，用于已核实的具体依赖；配合 `nextStep` 与当前负责对话展示。它不更改执行、验收或归档状态。真实运行优先；仅 blocked 而无依赖说明不会猜测原因。阶段验收与原生回合结束不等于整目标完成。

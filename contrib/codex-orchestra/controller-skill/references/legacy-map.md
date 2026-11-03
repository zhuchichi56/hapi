# 旧版规则对照

2026-11-03 重写前的 `SKILL.md`(151 行、约 25KB)全文保留在 `references/legacy/SKILL-before-two-layer-20261103.md`。下表说明旧版每一节现在在哪里;**没有静默删除的规则**,删掉的都写明原因。

| 旧版章节 | 现在在哪 |
|---|---|
| 已安装入口与事实源 | SKILL 开头;采集与服务限制 → [界面与汇报偏好](ui-and-reporting.md)「服务与限制」 |
| 接收、入账、派发(1–6) | [派发](dispatch.md) §1–§5 |
| 回报、验收、返工、归档(含 2026-11-02 决策分流) | [验收与归档](review-archive.md);决策分流 → [放权清单](delegation.md) A 栏;D2 询问条件 → [放权清单](delegation.md) B 栏 |
| 2026-11-03 交付报告格式、Task 为主体 | [验收与归档](review-archive.md) §5;[界面与汇报偏好](ui-and-reporting.md)「页面」「汇报」 |
| 静默内部协调与成果汇报(2026-11-03) | SKILL §二 末行与 §四;[验收与归档](review-archive.md) §1;[界面与汇报偏好](ui-and-reporting.md)「汇报」 |
| 总控内部并行核验;同一 Agent ≤3 个独立任务 | [派发](dispatch.md) §5;[验收与归档](review-archive.md) §2;[放权清单](delegation.md) |
| 主动回执、决策与持续跟进 | [工作者契约](worker-contract.md);[验收与归档](review-archive.md) §2(`decisionId`);统计 → [指标](metrics.md) |
| 系统运行指标与任务分开 | [指标](metrics.md);[界面与汇报偏好](ui-and-reporting.md)「页面」 |
| 服务与限制 | [界面与汇报偏好](ui-and-reporting.md)「服务与限制」 |
| 原对话延续与上下文交接;小上下文与逐跳召回 | [派发](dispatch.md) §5–§6 |
| 快速接单、授权与会话判断 | [放权清单](delegation.md);[派发](dispatch.md) §7;[验收与归档](review-archive.md) §5 |
| 事件与 Watchdog 边界 | 被取代:SKILL §四(两个唤醒源、唤醒门控、无定时心跳)。旧文"每 10 分钟 App 自动化巡检"不再适用 |
| Session 数量与进度口径 | [界面与汇报偏好](ui-and-reporting.md)「Session 数量」 |
| 简报、成果与关联 Session 的实际入口 | [验收与归档](review-archive.md) §3 |

## 有意不再保留的内容

- **每次派遣后在总控回复中列出任务清单**(2026-11-02):已被用户 2026-11-03 的"静默内部协调"要求覆盖(旧版自己也写了"此要求覆盖逐次派遣公示规则"),不再恢复。
- **10 分钟 App 自动化巡检**:已于 2026-11-03 14:34 暂停,按新设计不恢复,改由代码层门控的事件唤醒。
- 具体历史任务的处理说明(T004/T005 未派、T008 必须由父总控核验、EXT005 三 Session):是当时的状态,不是规则,留在账本与旧版全文里。

## 新增的内容

两个唤醒源与唤醒门控;汇报合同(含"不发"清单);六条冲突处理;[放权清单](delegation.md);项目审查(状态文件 + 一次性运行);六个指标与每周优化回合。

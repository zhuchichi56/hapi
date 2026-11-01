# 最小生命周期 fixtures

测试全部使用临时 state 目录，不接触真实账本。这里的 fixture 只描述最小事件序列；
可执行版本在 `test_orchestra.py` 的 `MultiTurnLifecycleTests` / `IdentityTests`。

| 场景 | fixture / 测试 | 最小事件序列 |
| --- | --- | --- |
| 多轮 rejected 后新回合完成 | `test_rejected_same_turn_repeats_but_new_inprogress_then_completed_awaits` | completed(turn-1) → reject → completed(turn-1) 仍 rejected → inProgress(turn-2) → completed(turn-2) = awaiting |
| accepted 后原聊天续查 | `test_accepted_turn_can_be_superseded_by_authorized_continuation` | completed(turn-1) → accept → inProgress(turn-2) = running/pending → completed(turn-2) = awaiting → 再 accept(turn-2) |
| 同回合重复观察 | `test_repeated_read_of_accepted_turn_keeps_accepted` | completed(turn-1) → accept → completed(turn-1, 新 revision) 仍 accepted；通知只一条 |
| 旧/乱序回调 | `test_out_of_order_observation_cannot_erase_new_acceptance`、`test_callback_for_older_reviewed_turn_cannot_erase_newer_stage` | 新验收后旧 observedAt 被拒绝；已评审旧 turn 即使 observedAt 更新也返回 `stale_turn` |
| 重启 | `test_contract_and_acceptance_history_survive_restart` | 合同修订 + completed + accept → 重新构造 `Ledger` 后字段与 `task_history` 仍在 |
| 历史验收证据 | `test_accepted_turn_can_be_superseded_by_authorized_continuation` | accept(turn-1) 与 accept(turn-2) 的 evidence/turnId 均可在 `Ledger.task_history` 查到 |
| 合同修订历史 | `test_contract_and_acceptance_history_survive_restart` | update-contract 两次；每次 before/after 完整 detail 按需召回 |
| 同 chat 绑定新任务拒绝 | `test_same_chat_cannot_be_reused_for_a_new_task` | T101 复用 T100 thread → TransitionError；T102 bind 已占用 thread → TransitionError |
| legacy 迁移：terminal 对应 | `legacy_review_cursor.json` case 1 + `test_legacy_terminal_cursor_at_review_time_binds_the_turn` | review op 之后未再观察的 completed cursor 可绑定 |
| legacy 迁移：inProgress cursor | `legacy_review_cursor.json` case 2 + `test_legacy_inprogress_cursor_is_not_bound_as_a_reviewed_turn` | 旧 review 保留，但不伪造 accepted turn；新 completed → awaiting |
| snapshot 有界历史 | `test_snapshot_history_is_bounded_summary_and_full_history_is_paged` | 25 次合同修订 → snapshot 仅 20 条 `id/kind/createdAt`；`task_history` 分页/上限可测 |

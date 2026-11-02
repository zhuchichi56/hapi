# T016 source semantics contract

本模块仅处理调用方已筛选的计数器快照和 DSH step_end 字段。四个公开函数无 I/O、无系统时钟读取、无全局累积状态，不调用模型，不读取原始事件或会话。调用方负责收集、持久化和明确的 task/phase/source 归属。

## 公共约束

- Python 3.9+，仅标准库；输入是普通 mapping/list，输出是可 JSON 序列化的安全字典，不修改输入。
- ID 必须匹配 `[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}`。ID 是调用方提供的非敏感、稳定、不透明标识；不能放凭据、地址、会话文本或原始文件内容。不回显无效 ID。
- token 与 revision、DSH turn/step 必须是非负 `int`，拒绝 bool、float、字符串、负数、NaN/Infinity。缺字段或 `None` 表示未知，不能转成 0。DSH turn/step 不自动转换字符串。
- 时间接受有限、非负 epoch **秒**，或有时区的 ISO 8601；输出统一为 epoch 秒。毫秒量级 epoch、无时区字符串、bool、非有限值无效。等价整数/浮点/时区表达得到相同观察标识。
- 失败只返回固定 reason 与安全字段；不复制未知键、body、reasoning 文本、错误原文或 `last`。`reasoningOutputTokens` 仅为数值元数据。
- 所有计费结果均为已观察子集。顶层 `inputTokens`、`outputTokens` 永远为 `None`，`phaseTokensComplete=false`。任何结果都不是 `turn_total`。

## native_counter_window(before, after, scope)

输入快照：

```python
{
    "threadId": "thread-1", "phaseId": "phase-1",
    "observedAt": 40, "revision": 2,  # revision 可两端均省略
    "tokenUsage": {
        "total": {
            "inputTokens": 1120, "outputTokens": 230,
            "cachedInputTokens": 440, "cacheWriteInputTokens": 110,
            "totalTokens": 1350, "reasoningOutputTokens": 45,
        },
        "last": {},  # 完全忽略，包括其数值有效性
    },
}
```

scope 必须包含 `taskId, phaseId, threadIds, startedAt`，以及 `endedAt` 或开放阶段的 `asOf`。`threadIds` 是显式注册的 list/tuple。before/after 必须属于同一个已注册 thread 和 scope.phaseId；可选 `turnId` 不参与归因。

**纯函数的时间依据：** 封闭阶段 `endedAt` 是调用方声明的已发生阶段结束上界；开放阶段必须传入调用方采集的 `asOf`，不能省略上界。两者同时存在时要求 `startedAt <= endedAt <= asOf`。样本必须在 `[startedAt, endedAt]` 或 `[startedAt, asOf]` 内；未来于该上界的样本拒绝。模块无法凭数据本身知道真实当前时间，调用方必须提供可信上界，不能使用预计的未来 endedAt。需要核验封闭阶段相对于当前采集时刻的未来时间时也应传 `asOf`。

检查规则：

1. 两端时间、revision 不倒退；revision 若出现，必须两端都存在且有效。时间或 revision 相同且所有受跟踪计数相同，返回 `status='duplicate'`，不产生 window；相同观察标识但计数不同则拒绝。
2. 检查所有已知受跟踪计数，包括 reasoning。两端都有值的任何计数下降均拒绝，`reason='counter_decrease', resetDetected=true`；不猜测 reset、compaction 或新基线。
3. 已知端点与差分必须满足 `input+output=total`、`cacheRead+cacheWrite<=input`；部分缓存已知时，其已知和也不能大于 input。违反则拒绝。
4. 只对两端都已知的字段做减法。缺 baseline/usage/total mapping、或没有任何核心计数的共同基线，不能退回 lifetime 或 last。未知指标保留 `None`。
5. 采用保守的证明条件：两个端点的 input/output/total/cacheRead/cacheWrite 全部已知且上述等式、约束通过，才输出 `cacheConvention='included_in_input'` 和 native total 差分。证明不完整时保留已知单项差分，但 `totalTokens=None, cacheConvention=None`；不从 input/output 自行补 total。

成功结果包括：

- `source=sourceId='native_desktop'`，安全 task/phase/thread 标识。
- `windowId=SHA256`，编码 source、thread、phase、前后 `[observedAt, revision]`；与字典键顺序、`last`、未知字段无关。
- `windowStart, windowEnd, beforeRevision, afterRevision`；`clock='observation_wall', timestampUnit='epoch_seconds'`，明确是采集时钟。
- `scope='observed_counter_window', coverage='partial'`。
- `observedTokens` 中的 input/output/cacheReadInput/cacheWriteInput/total 差分；native `cachedInputTokens` 映射为 `cacheReadInputTokens`。
- `metadata.reasoningOutputTokens` 是差分，不加入 total，不作为会话 reasoning 内容输出。

native `total` 是线程终身累计；`last` 只是最新 request，既无 request ID 也无 request 时间。二者都不能直接指定给某个 task turn。native live turn start/completion 为 null；独立 read_thread 元数据为 epoch 秒。调用方分别采集 phase/turn 元数据与至少两个快照，不能把观察窗口边界伪装为真实 turn 起止。采集间隔也不等于计算活跃时长。

## aggregate_counter_windows(windows)

输入为上述归一化记录的 iterable；非 native/非有效 window 计入 `rejectedRecords`，不混入 token。`duplicate` 观察响应单独计入 `duplicateObservations`，不计作拒绝或 window。跨 task/phase 的有效记录使整个批次拒绝，调用方应先按 task/phase 分组。

- 相同 windowId 的相同安全核心记录只计一次，额外副本计入 `duplicateRecords`。同 ID 内容冲突则排除所有涉及 thread 的整组 windows。
- 同 thread 只要存在正长度重叠（包括嵌套），保守排除该 thread 的**全部** windows；不选择较大值。半开区间 `[start,end)` 相邻端点可以相接，安全相加。
- 不同 thread 可以累加已观察 token。时间取所有保留区间的并集，`observedElapsedSeconds` 不按 thread 相加，不代表 active compute。无保留区间为 `None`。
- `coverage='partial'` 始终不变。`coverageCounts` 给出 receivedRecords、uniqueWindows、acceptedWindows、duplicateRecords、duplicateObservations、rejectedRecords、conflictingWindowIds、excludedAmbiguousWindows 和 metricKnownWindows。
- `observedTokens[k]` 仅在每个保留 window 的该指标都已知时有值；`knownObservedTokens[k]` 是已知保留子集之和，必须结合 `metricKnownWindows[k] / acceptedWindows` 阅读。两者都只描述保留观察窗口，不包含被排除区间或未采集区间。没有已知值为 `None`，测得 0 才是 0。

## normalize_dsh_step(event, scope, source_id)

event 只允许以下来源字段参与语义：

```python
{
    "type": "status", "phase": "step_end", "turn": 1, "step": 2,
    "usage": {"inputTokens": 10, "cacheReadTokens": 5,
              "outputTokens": 3, "totalTokens": 18},
}
```

scope 为 `{taskId, phaseId, executorId, startedAt, endedAt?}`。必须由 owner 显式保证 executor 与 task/phase 的**独占映射**；模块无法从事件推断或验证实际执行器归属。`source_id` 必须稳定标识同一事件来源，重放不能换 ID。不同来源不可隐式合并。

- 仅显式 `type='status', phase='step_end'` 构成分母候选。step_start、其他 status 或其他 type 返回 `ignored`，不增加 missing usage。
- `stepId=SHA256(["dsh", source_id, turn, step])`；不同 task/phase/executor 不能借同一个 stepId 合并。
- DSH `inputTokens` 是 **uncached**。只有 input/read/output/total 全部已知且总数恒等式通过时，`observedTokens.inputTokens=inputTokens+cacheReadTokens`；原 uncached 单独保留为 `uncachedInputTokens`。缺少原始 total 时，未上报的 cacheWrite 可能仍有投入，因此完整含缓存输入保持 `None`，uncached/read 证据分别保留。
- read 映射为 `cacheReadInputTokens`；`cacheWriteInputTokens` 永远 `None`，即使未知原始键含 cacheWrite 也忽略；不能补 0。
- 只有原始 input/read/output/total 全部已知并满足 `input+read+output=total`，才能保留原始 total。等式不符拒绝；不完整时 total 为 `None`，不推导补全。
- `reportedUsage` 仅保留四个允许的安全源计数（含未经验证的原 total），用于识别部分 usage 的冲突；它不是可汇总的 total。无 usage 为 `None`，无效数据不回显。
- 无 usage 或四个值全未知返回 `missing`；部分合法 usage 返回 accepted 并保留逐指标未知；无效 usage 返回 rejected。可识别的 stepId 随 missing/rejected 保留，使聚合能准确计入缺失分母。
- `coverage='executor_observed_steps'`，`clock=None`；scope 的起止不是 step 的时间。事件无时间戳，不输出 step 时间或耗时。

## aggregate_dsh_steps(steps)

输入为归一化的 step 记录 iterable。有效记录必须同 task、phase、executor、sourceId，否则整个批次拒绝。native 输入不混入。无有效 step 身份的记录计入 rejectedRecords，因无法识别唯一 step，不虚构其分母。

同 stepId 的等价安全源计数重放去重。任何内容冲突（包括 missing 后来变 complete、未经验证的原 total 不同）都会使该唯一 step **整步缺失**；不取最大值，不选择最后一次，不借冲突事件补全。冲突是粘性的；后续再重放其中一份也不能恢复该 step。

覆盖计数的精确定义：

| 字段 | 定义 |
| --- | --- |
| receivedRecords | 传入记录数，含重放、ignored、rejected |
| uniqueStepEnds | 可识别、归属同 scope 的唯一 stepId 数；包含 missing、invalid、conflict |
| stepsWithUsage | 无冲突且有至少一个有效源计数的 step 数；部分指标仍可能未知 |
| missingUsageSteps | uniqueStepEnds − stepsWithUsage；含完全缺失、无效、冲突 |
| recordsWithoutUsage | 去重后无冲突的 missing step 数；名称虽为 records，单位为唯一 step |
| invalidUsageSteps | 去重后无冲突的 rejected step 数 |
| conflictingSteps | 出现内容冲突的唯一 step 数 |
| duplicateRecords | 同身份同安全内容的额外副本数；冲突值不计重复 |
| ignoredRecords / rejectedRecords | 非 step_end / 无法作为有效归一化 step 处理的记录数 |
| metricKnownSteps[k] | 无冲突 accepted step 中 k 指标已知的数量，分母为 uniqueStepEnds |
| uncachedInputKnownSteps | 无冲突 accepted step 中 uncached 已知的数量 |

`observedTokens[k]` 要求所有 uniqueStepEnds 的 k 都已知才输出；`knownObservedTokens[k]` 仅为已知 accepted 子集的和，必须同时展示覆盖分母。`knownUncachedInputTokens` 同理。空集/全未知输出 `None`。缺 cacheWrite 始终未知。`observedElapsedSeconds=None`，不从 scope 或计数推测时间。所有结果继续 `phaseTokensComplete=false`。

## Owner 集成边界

仅作为独立来源证据放入 `tasks[].investment`，例如 owner 在已有聚合层执行：

```python
investment["observedWindows"] = {
    "records": native_windows,
    "summary": aggregate_counter_windows(native_windows),
}
investment["executorUsage"] = {
    "records": dsh_steps,
    "summary": aggregate_dsh_steps(dsh_steps),
}
```

owner 应先分 task/phase，DSH 再分 executor/source；持久化或回放须把所有待聚合证据一次提供，函数不会暗中跨调用记忆。相同 native snapshot 用不同收集通道仍属同 source/thread；DSH source_id 必须稳定。native 与 DSH 可能描述相同工作，不能把两者相加，也不能自动指定任何一个为 phase 总额。

`phase_metrics.py` 只接受明确的 turn_total；本模块从不生成该类型，不能把这些记录投递为 turn_total，也不修改其实现。task phase 的真实起止、turn 列表、executor 归属、全量使用覆盖及真实数值由 planner/owner 单独验证。本交付没有接入 collector 或改变已丢弃字段的既有 adapter。

## 本地验证

```sh
python3 -B -m unittest discover -s tests -p 'test_phase_sources.py' -v
```

全部 fixtures 为本地合成计数，不含 native 会话、DSH 原始记录或真实模型用量。测试覆盖差分/last 忽略/无基线、scope 与时间/版本校验、重置、缓存一致性、幂等/重叠/相邻/多线程、逐指标未知、DSH 换算/重放/冲突/缺失、归一化结果篡改与隐私白名单。

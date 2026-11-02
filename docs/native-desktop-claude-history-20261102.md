# Claude 真实接入与 Codex 历史补载 · 2026-11-02

Claude 沿用已有原生桥接，无需再次注册、配置模型凭据或部署新服务。可从 <https://hapi.urbanclaw.net/desktop?app=claude> 或 <https://desktop.urbanclaw.net/desktop?app=claude> 选择原会话或新建。两域名的登录存储互相隔离，首次使用需要分别登录。普通 HAPI `/sessions` 的独立 CLI 会话与 Claude 普通云端聊天不在本次接管范围。

## Claude 单次真实往返

北京时间19:38:49，在本聊天独立后台浏览器通过真实网页新建一个验收会话，仅提交一次无工具、无文件修改的固定标记请求。create 返回HTTP200/ok和原生sessionId；21.3秒后网页显示正确回复，只有一条用户消息，零页面错误、零横向溢出。

主负责人随后从原 Claude metadata 和原 `.claude/projects` transcript 独立确认同一原生身份、恰好一条非meta用户消息、正确assistant文本、end_turn、零工具调用及桌面默认模型未被覆盖。原HAPI域名独立登录后可读同一回复。最后从网页归档验收会话，独立核对原metadata的归档状态。未向业务会话发送、停止原任务或改变账号权限。

DSH只做限定代码审查和23项既有Claude测试，不执行真实浏览器或原生写入。上述真实验证均由主负责人完成。被动AX检查在App后台无窗口树时不提供选择状态，未将它当成UI选择成功证据。metadata/transcript落盘竞态、冷启动窗口和特殊弹窗仍不能靠本次单个成功样本推断已覆盖。

## 完整历史超时的含义与修正

生产日志11:46:11 UTC记录一次read在5026ms失败，脱敏指纹与用户报告的`Desktop request timed out: thread-follower-load-complete-history`精确一致。该方法用于在已显示历史的起点请求更早记录，adapter默认等待5000ms；它不是启动模型或发送消息的方法。为什么原owner未及时回执，当前证据仍不足以归因于特定网络、线程长度或App内部错误。

修复只处理这条可选读取的失败边界：

- 同一原会话/owner的并发补载共用一个在途请求。
- 超时后重新读取最新原生snapshot；保留已读内容，返回明确的历史补载错误，保留不完整标记。
- 如果原生history实际上已完整，只是ack晚到，正常返回完整快照。
- 真实断线继续失败，不拿旧内容伪装连接成功。
- 旧页读取失败保留cursor、正文和草稿，不改变当前聊天连接状态；显式重试时清除旧提示，可正常接续更早内容。

没有提高超时、自动重发写入或声称完整历史已提速。本批未做真实Codex发送验收。

## 验证、部署与边界

仓库31项native测试通过。合并实际生产源后8项相关history测试通过；完整候选31项中30通过，旧unloaded-send fixture未提供生产后来新增的turn receipt，原installed baseline在同一fixture上也失败。本批保留生产既有的严格发送确认规则；不能把本次读取验收当作所有写入正常的证明。

生产Web resilience/status共11项通过，包含超时保留正文、草稿、发送可用、原cursor重试和恢复后清除旧提示。Web/Hub类型检查、Web构建、嵌入551个静态资源和Hub编译通过。

仅合并两份Web文件和native-host；1890个其他源文件一致，保留独立Orchestra、原生状态和可信父进程修复。Hub二进制SHA256为`c09370d39cdd38697a17afbb2a0a4e0a2eb9af8672936e2cf75077cd7e662d8c`，安装的native-host为`329ef813e41b6f6340ae9d656622edec928376732ca7607365c54488133b96da`。初次Hub恢复检查窗口到期，后续核实同一个新listener和HTTP200，无第二次重启；原App、app-server、Claude进程始终保留。

上线后实际浏览器加载新资源，当前原Codex会话正文可读、无错误、输入框可用、无横向溢出；原生Codex与Claude读取分别21ms/23ms成功。单次本地结果不代表公网长期稳定或完整历史补载速度。

私有证据：x20工作根`work/t015-hapi-claude/`，含唯一Claude请求/原生回执、原HAPI入口、归档确认、测试和部署记录。Mini回滚在`~/.local/lib/hapi-mini/native-history-timeout-20261102-backup/`；桥接原文件在该工作目录`bridge-before-history.mjs`。回滚前同样核对当前身份/散列，避免覆盖后续生产更改。报告及Git不包含访问码、JWT、Cookie或业务会话正文。

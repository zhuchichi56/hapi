# HAPI 桌面原会话桥接

入口：https://hapi.urbanclaw.net/desktop 。已部署到现有 Mac mini HAPI，使用 mini 当前访问令牌。此前迁移时已轮换令牌，迁移前保存的旧令牌会返回 401；桌面桥接本身没有再次轮换。选择 Codex 或 Claude Code 后，可以读取桌面历史、新建桌面原会话、向同一会话发送消息。

## 架构

手机文字页面 → 已认证的 HAPI Hub → 现有 SSH 隧道转发的私有 UNIX socket → MacBook 上的原桌面 App。

- Codex：桌面 App 工具管道负责列表和新建；原生 owner/follower IPC 负责快照、输入和停止。沿用原生 thread ID 与执行进程。
- Claude：原 App 的 Code 会话元数据和原运行时 transcript 提供历史；长驻 macOS Accessibility helper 通过原输入框、Send、Stop 操作同一桌面会话。未启动独立 CLI。
- 新桥接不创建数据库，不复制完整历史。旧 HAPI SQLite 保留；此前约 2.5 GiB 的主要占用是历史消息。
- 仅 HAPI `default` namespace 可以访问个人桌面；未登录返回 401，共享 namespace 返回 403。
- socket 父目录 0700、socket 0600；不新增公网监听端口。写请求使用 action ID 内存去重，超时不自动重放。

## 文件与启动

- `codex-desktop.mjs`：Codex 私有桌面 IPC、快照及控制协议。
- `native-view.mjs`：最近消息窗口、历史游标、版本摘要和按需完整消息/工具输出，不另存历史。
- `native-delegation.mjs`：识别真实 DSH 启动、进度检查和续跑调用，提供紧凑标签。
- `native-media.mjs`：仅接受该条原始消息引用的本机图片，按需转成小型 JPEG 预览。
- `native-host.mjs`：私有 HTTP-over-UNIX 入口、校验、去重及两种 App 适配器。
- `claude-native.mjs` / `claude-ax.swift`：Claude 历史读取、串行操作与原生 UI helper。
- `native-mcp.pl` / `native-mcp.mjs`：由 Codex MCP 子进程启动一个桥接 host，其他进程轻量跟随；没有模型请求和工具注册。host 退出后约十秒接力。
- `*.test.mjs`：相关单元与模拟 IPC 检查。
- `probe.mjs`：Codex 只读连通性检查。

MacBook 安装目录：`~/.local/lib/native-desktop-bridge/`。私有状态目录：`~/.local/state/native-desktop-bridge/`，内含 `config.json`、`host.sock`。

`config.json` 配置 `callerThreadId`（真实 Codex 调用会话）及 `claudeSessionDirectory`（当前 Claude Code profile 的会话目录）。不把令牌写入此配置。

现有 Codex MCP 配置：

```toml
[mcp_servers.native_desktop_bridge]
command = "/usr/bin/perl"
args = ["/Users/zhuhe/.local/lib/native-desktop-bridge/native-mcp.pl"]
enabled = true
startup_timeout_sec = 16
```

当前宿主 Node 路径为 `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`。必须保留桌面 App 的可信祖先进程；普通 LaunchAgent 直接启动会被当前 Codex 拒绝。上述配置已经接力实测。

编译 Claude helper（原子更新，避免覆盖运行中的二进制）：

```sh
swiftc -O claude-ax.swift -o "$HOME/.local/lib/native-desktop-bridge/claude-ax.next"
mv "$HOME/.local/lib/native-desktop-bridge/claude-ax.next" "$HOME/.local/lib/native-desktop-bridge/claude-ax"
```

更新 JS 后，在没有进行中的写操作时终止本任务 host 的确切 PID；Codex 的 follower 会接力加载新文件。不要按 Node 或 Claude 的通用进程名终止进程。

mini 构建副本：`~/.local/lib/hapi-mini/builds/quick-session-20261026/`；Hub 生产程序：`~/.local/lib/hapi-mini/bin/hapi-hub`，由现有 `com.zhuhe.hapi-mini` LaunchDaemon 恢复。前一版程序保留为 `hapi-hub.before-native-desktop-20261026`。

`com.zhuhe.hapi-mini-tunnel` 保留 loopback 3006 转发，并将 mini 的 `~/.local/lib/hapi-mini/desktop/host.sock` 反向连接到 MacBook 私有 socket。不要把这条连接改成公开 TCP。

## 验证

```sh
node --test *.test.mjs
node probe.mjs <existing-codex-thread-id>
```

22 项桥接相关测试通过；另有 3 项前端定向测试覆盖按需工具结果、历史分页和长草稿清空后输入框收缩。真实桌面验收：Codex 新建、原会话后续发送、实时读取、运行轮次停止通过；Claude Code 新建及同一原会话第二次发送通过，桌面与手机页均看到实际回复。手机布局按 390×844 检查。

外部服务器经公网域名认证、读取两个 App 的原会话列表及验收聊天通过。锁屏检查通过：Claude 历史仍能读取，显示 Mac 已锁屏，写操作在 UI 导航前拒绝。审批按钮有基础实现，尚未完成真实审批端到端验收。

## 使用边界

- MacBook、隧道、Codex 与 Claude App 必须在线。Claude 发送、停止需要 Mac 保持解锁；不会绕过系统锁屏。没有验收合盖休眠或整机重启。
- Claude 操作会切换桌面当前打开的 Code 会话；已有桌面草稿不会被覆盖。未打开会话的运行状态可能无法确认，页面不将其标为空闲。
- Codex 未载入的历史会话可以读取；发送需要有原生桌面 owner，必要时先在桌面打开。当前列表是 App 工具返回的置顶会话加最近 50 条，未提供全历史分页。
- 当前协议依赖已安装的桌面版本；App 升级后须重新验收。没有修改或重签名 Claude App，也没有开启调试端口。
- 手机若显示更新提示，点击 Reload。公网网络延迟随当前 Cloudflare 路由变化。

## 阅读性能与跟随（2026-10-27）

- 初次显示最近最多 80 条记录，并限制每页体积；点击“更早的消息”继续读取，保留阅读位置。工具调用分组收起，展开具体调用后才下载完整输出，大输出可续读。
- 原生会话 ID 保留；revision 未变时仅返回 unchanged，不重复解析整段 Markdown。活动会话读完约 1.2 秒后再次检查，空闲约 3 秒；网络耗时另计。最近 12 个会话视图只在浏览器内存缓存，回切可立即显示。
- 位于底部跟随新回复；上翻时暂停跟随，可点“最新消息”返回。发送有即时气泡，输入框随草稿增长，清空后自动收缩。中文正文、代码、列表和表格使用独立阅读排版，390×844 手机尺寸无页面横向溢出。
- Claude 直接读取原 transcript，不再等待 Accessibility 窗口选择完成；窗口状态在原串行队列后台更新。无法确认的后台会话不显示运行或空闲结论。Codex 历史不再先等待完整 owner 发现，最多保留 4 个原生订阅。
- 同一真实长 Codex 会话原先每次约 2,107,553 字节；优化后本机约 41 KB（首次 218 ms、缓存 4 ms）。本次外部服务器经公网读该长会话返回 41,209 字节、0.53 秒；紧接着 unchanged 为 121 字节、0.37 秒。更新中的消息可能改变实际体积。这些数据不代表所有手机网络延迟。
- 真实 Chrome 长对话验证了回复更新、上翻不抢位置和更早历史；手机尺寸的原生验收会话通过中文列表、表格、代码和新回复自动跟随。未宣称工具详情也逐字流式更新。
- 生产前一版备份：mini 的 `~/.local/lib/hapi-mini/bin/hapi-hub.before-reading-20261027`；构建入口仍是上述 mini 工作副本。


## Codex 风格与紧凑显示（2026-10-27）

- 按用户提供的 Codex 截图调整 244px 侧栏、单行会话、正文留白、灰色用户气泡、浅灰工具行和底部圆角输入框；桌面和手机共用响应式布局。
- Codex 已确认的原始用户消息出现后，移除相同内容的无 ID 临时输入占位；保留真正重复发送的原消息及尚未确认的新输入。
- 空闲时不显示“已就绪”；运行时列表仅显示小圆点，正文不重复显示“正在回复”。停止按钮保留；锁屏、必须先打开桌面会话及断线仍显示操作提示。输入框不重复显示“已连接”。
- Claude 相邻的原生工具调用和返回记录跨 turn 合并，默认折叠；首次打开组才挂载工具行，再打开某条工具才取完整结果，折起后保留已加载结果。
- 实际 DSH shell 调用显示 DSH 标签，区分委托、检查和纠偏。不把启动脚本退出当外部任务完成；未实现独立 DSH 任务的实时状态监控。
- 会话置顶保存在当前浏览器的 localStorage，按 App 与原生 ID 区分，原 Codex 置顶作为默认。不同设备与桌面 App 的置顶修改暂不同步。
- 图片默认最大 180×120px，点击切换放大预览。远程图片懒加载；本机图片按可见范围读取，删除或无效图片显示文字占位。本机原文件上限 16MiB，转换最长边 480px、JPEG 质量 65，结果上限 400KB，内存最多缓存 32 张，不额外落盘保存历史图片。
- 本机图片请求沿用已认证的 read 操作与稳定 itemKey；必须匹配该条原始消息的 Markdown 图片引用，校验真实图片格式，临时转换文件自动删除。没有新增公开文件服务。
- 验证：桥接 25 项、前端 19 项相关测试通过，Web 类型检查和生产构建通过。真实 Claude 80 条窗口中的 73 条工具合并为 3 组，默认工具行 DOM 为零；展开后成功读取原工具结果，DSH 标签可见。浏览器视觉复查和最终部署状态见任务交付记录。
- mini 回滚文件：`hapi-hub.before-comfort-20261027`；仅最后状态精简之前的版本另存为 `hapi-hub.before-status-20261027`。

最终真实浏览器复查：桌面已应用 Codex 风格与状态减噪，重复输入占位已消失；手机 390×844 的本机小图为 180×99px，放大约 340×188px，页面无横向溢出。实现提交 `e937d3e4`。


## 归档、链接和发送按键（2026-10-27）

每条会话右侧「⋯」提供复制链接、置顶和归档；侧栏底部「已归档」可恢复。归档和置顶仅保存当前浏览器，桌面原会话和运行任务保留。链接使用 `/desktop?app=codex|claude&thread=<native-id>`，登录后直接打开同一原会话，不要求它位于最近列表；顶栏也能复制当前链接。链接不包含访问令牌，复制受限时显示可选中文本。

Enter 直接发送，Shift+Enter 换行；中文输入法确认候选时不会误发。23 项相关 Web 测试、类型检查和构建通过。真实原生 Codex 会话 Enter 收发、归档刷新与恢复、两种 App 链接、公网 Chrome 复制成功已验收。回滚文件为 `hapi-hub.before-actions-20261027`。

## 原生链接、状态和图片发送（2026-10-27，当前行为）

- 默认复制 `codex://threads/<id>` 或已验证的 Claude Code `claude://claude.ai/epitaxy/<id>`。Codex 格式与安装中 App 的复制会话链接实现一致。菜单另有“复制网页链接”，继续使用前述 `/desktop?...` 路由。原生链接需目标设备安装相应 App，网页链接用于浏览器接着聊。
- 会话运行标记为 13px 绿色呼吸圆环，结束为蓝色实心勾；工具保持折叠，运行时显示低干扰动点及最近工具摘要。备用读取复用相同 normalizer，保留 MCP 调用和文件修改，排除 reasoning；原 App 拒绝超大读取时，仅重试一次不含输出的单轮读取。已对本条超长原会话验收：41,844 字节、67 条工具，状态 active。
- 页面轻量读取两个 App 的会话列表，只有观测到运行→结束才让另一个 App 标签柔和呼吸四次，无完成文字弹窗。Claude 当前桌面会话用原 Stop 控件确认运行；其他会话仅在原 transcript 明确 end_turn/stop_sequence/轮次结束时显示结束，其余保持未知，不凭进程或时间猜状态。Claude 写操作仍会切换共享桌面窗口，后台列表读取不切换会话。
- Claude 同会话运行中追加输入沿用原 App 队列。本机专用会话实测 sleep 工具继续完成，随后处理新消息；桥接现在识别原生 enqueue 回执，避免把排队误报为发送失败，并显示被消费的原生 queued_command 人类消息。另开新会话是独立任务，现有任务不会被替换。
- Codex 新建页可选原 App 工具实际支持的模型，默认项不传 model，不修改已有会话或全局配置。实际指定 gpt-6.1-sol 新建并附图成功。Claude 仍沿用桌面默认模型。
- 支持选图、粘贴、拖入，每条最多 4 张。发送前 58px 缩略图可移除，消息中默认最多 180×120px，点击放大。较大图片在浏览器缩至最长边 2048px/每张约 1MB；GIF 发送静态首帧。私有认证通道传输，MacBook 的 `~/.local/state/native-desktop-bridge/attachments/` 以内容哈希保存 0600 图片文件，供原生历史继续引用；没有新增 SQLite、公开文件地址或模型执行器。Codex 原生追加使用 localImage；新建通过原 create_thread 的图片上下文；Claude 粘贴到原输入框并保留系统剪贴板。
- 两个原 App 都实际识别出测试图的红背景与蓝色正方形，公网前端选图→预览→Enter→原生回复也通过。390×844 无横向溢出。聚焦验证覆盖桥接新增行为、前端附件及完成提示；Web/Hub 类型检查和生产编译通过。
- 归档、置顶仍仅保存在当前浏览器，不同步归档 ChatGPT/Codex/Claude 原会话，不停止任务。回滚：`hapi-hub.before-images-20261027`。

# HAPI 桌面原会话桥接

入口：https://hapi.urbanclaw.net/desktop 。已部署到现有 Mac mini HAPI，沿用原登录。选择 Codex 或 Claude Code 后，可以读取桌面历史、新建桌面原会话、向同一会话发送消息。

## 架构

手机文字页面 → 已认证的 HAPI Hub → 现有 SSH 隧道转发的私有 UNIX socket → MacBook 上的原桌面 App。

- Codex：桌面 App 工具管道负责列表和新建；原生 owner/follower IPC 负责快照、输入和停止。沿用原生 thread ID 与执行进程。
- Claude：原 App 的 Code 会话元数据和原运行时 transcript 提供历史；长驻 macOS Accessibility helper 通过原输入框、Send、Stop 操作同一桌面会话。未启动独立 CLI。
- 新桥接不创建数据库，不复制完整历史。旧 HAPI SQLite 保留；此前约 2.5 GiB 的主要占用是历史消息。
- 仅 HAPI `default` namespace 可以访问个人桌面；未登录返回 401，共享 namespace 返回 403。
- socket 父目录 0700、socket 0600；不新增公网监听端口。写请求使用 action ID 内存去重，超时不自动重放。

## 文件与启动

- `codex-desktop.mjs`：Codex 私有桌面 IPC、快照及控制协议。
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

16 项相关测试通过。真实桌面验收：Codex 新建、原会话后续发送、实时读取、运行轮次停止通过；Claude Code 新建及同一原会话第二次发送通过，桌面与手机页均看到实际回复。手机布局按 390×844 检查。

外部服务器经公网域名认证、读取两个 App 的原会话列表及验收聊天通过。锁屏检查通过：Claude 历史仍能读取，显示 Mac 已锁屏，写操作在 UI 导航前拒绝。审批按钮有基础实现，尚未完成真实审批端到端验收。

## 使用边界

- MacBook、隧道、Codex 与 Claude App 必须在线。Claude 发送、停止需要 Mac 保持解锁；不会绕过系统锁屏。没有验收合盖休眠或整机重启。
- Claude 操作会切换桌面当前打开的 Code 会话；已有桌面草稿不会被覆盖。未打开会话的运行状态显示待同步，不能据此认定空闲。
- Codex 未载入的历史会话可以读取；发送需要有原生桌面 owner，必要时先在桌面打开。当前列表是 App 工具返回的置顶会话加最近 50 条，未提供全历史分页。
- 当前协议依赖已安装的桌面版本；App 升级后须重新验收。没有修改或重签名 Claude App，也没有开启调试端口。
- 手机若显示更新提示，点击 Reload。公网网络延迟随当前 Cloudflare 路由变化。

# Desktop 专用域名与更新方式 · 2026-11-01

## 两个入口

- `https://desktop.urbanclaw.net`：原生桌面专用入口，首页进入 `/desktop`，标题为 Urban Desktop。
- `https://hapi.urbanclaw.net`：保留普通 HAPI，登录后首页进入 `/sessions`；既有 `/desktop?app=...&thread=...` 链接继续可用。

两个域名使用同一 Hub、桥接和网页登录码。浏览器按 origin 隔离 localStorage，因此新域名首次使用要登录一次；不复制浏览器令牌，不另建会话数据库。

当前隧道配置此前已经包含 desktop hostname → loopback 3006。Mini 的 `web/index.html` 也已经在路由初始化前对专用域名的根路径执行 `history.replaceState`，保留 query/hash 并进入 `/desktop`；同时设置专用标题、图标和 `/desktop.webmanifest`。所以本次只核验并记录现有能力，无需新增 DNS、再次部署或重启连接器。普通 HAPI 根路径不触发该规则。

生产 Hub 保持上一轮速度优化版本 SHA256 `1746c248c6b56473058102387d5203cd8e826a17f226f082e9a89d04a2d7a965`。

## 实际浏览器核验

使用本聊天独立后台 agent-browser 会话及既有代理路径，分别访问两个公网根域名，使用当前 owner 登录码在内存中填写并登录：

- desktop：进入 `/desktop`，标题 Urban Desktop，原生列表显示66个 Codex 会话，无连接错误。
- hapi：进入 `/sessions`，标题 HAPI，未进入原生桌面页，登录完成且无原生连接错误。
- desktop 的 Claude 列表显示28个原会话，无连接错误；未发送消息或执行其他原生写操作。

两个域名的公网 HTML 读取均成功，内容和资源 hash 与现有 Mini 转发一致。该次成功只证明当前窗口和所测网络路径；不代表所有公网线路永久稳定，也不以单纯 DNS 解析或 HTTP200 代替登录后核验。

证据：x20 `work/desktop-domain-20261101/browser-acceptance.json` 及日志。记录只含域名、路径、标题、计数和状态；登录码、JWT、Cookie 及完整会话内容不写入证据、Git 或聊天。

## 为什么刷新会得到更新

上一轮用户要求修复加载与跟随卡顿，主会话手动完成了源码修改、聚焦测试、生产构建、嵌入静态资源、Mini Hub 原子替换及重载。HTML 引用带内容 hash 的 JS/CSS：刷新获取新 HTML 后，浏览器取新的资源地址，未改变的资源可以继续使用缓存。

上一轮只重载中转 Hub；模型执行进程、桌面 App 和原会话保持运行。短暂重载可能让网页读取重新连接，但不依靠网页存活来持续执行原任务。本次域名核验没有替换 Hub。

## 桥接原理

浏览器的文字界面 → Cloudflare 现有隧道 → MacBook loopback/SSH 转发 → Mini HAPI Hub（认证）→ SSH 反向转发的私有 UNIX socket → MacBook 桌面桥接 → 原 Codex/Claude App。

Codex 使用原桌面的 owner/follower IPC 读取与控制；Claude 使用原运行记录读取历史，通过原桌面控件执行发送、停止等操作。网页呈现原 thread/session 身份的数据，指令送回原会话，不额外运行独立 CLI 对话。发送等写操作保留既有确认与不确定投递处理，不因网络断开盲目重发。

网页只按需传文字、工具结果和小图，比持续传整张桌面画面轻。MacBook、Mini、原 App 与两段连接仍是运行依赖；换域名提供清晰的入口，并不减少这些依赖或自动提高底层网络速度。

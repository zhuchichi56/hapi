import Foundation
import AppKit
import ApplicationServices

struct Node: Codable {
    let path: [Int]
    let role: String
    let title: String
    let value: String
    let description: String
    let url: String
    let actions: [String]
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ value: CFTypeRef?) -> String {
    if let string = value as? String { return string }
    if let url = value as? URL { return url.absoluteString }
    return ""
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    let direct = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    if !direct.isEmpty { return direct }
    if text(attribute(element, kAXRoleAttribute)) == kAXApplicationRole { return attribute(element,kAXWindowsAttribute) as? [AXUIElement] ?? [] }
    return []
}
func flatten(_ root: AXUIElement) -> [(Node, AXUIElement)] {
    var result: [(Node, AXUIElement)] = []
    func walk(_ element: AXUIElement, _ path: [Int], _ depth: Int) {
        if depth > 55 || result.count > 8000 { return }
        let role = text(attribute(element, kAXRoleAttribute))
        if role == kAXMenuBarRole || role == "AXSecureTextField" { return }
        var raw: CFArray?
        AXUIElementCopyActionNames(element, &raw)
        let node = Node(path:path,role:role,title:text(attribute(element,kAXTitleAttribute)),value:text(attribute(element,kAXValueAttribute)),description:text(attribute(element,kAXDescriptionAttribute)),url:text(attribute(element,kAXURLAttribute)),actions:raw as? [String] ?? [])
        result.append((node,element))
        for (index, child) in children(element).enumerated() { walk(child,path+[index],depth+1) }
    }
    walk(root,[],0)
    return result
}
func emit(_ value: Any) {
    if let data = try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
}
func fail(_ message: String) -> Never { emit(["ok":false,"error":message]); exit(1) }
func handle(_ command: [String:Any]) {
guard let operation = command["op"] as? String else { fail("Invalid desktop command") }
if let session = CGSessionCopyCurrentDictionary() as? [String:Any], session["CGSSessionScreenIsLocked"] as? Bool == true {
    if operation == "inspect" { emit(["ok":true,"locked":true,"selectedId":"","nodes":[]]); return }
    fail("Mac 已锁屏，Claude 桌面操作需要先解锁；历史仍可读取")
}
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier:"com.anthropic.claudefordesktop").first else { fail("请保持 Claude 桌面 App 开启") }
guard AXIsProcessTrusted() else { fail("macOS 无障碍权限未授权给桌面桥接进程") }
let pid = app.processIdentifier
let root = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(root,3)
AXUIElementSetAttributeValue(root,"AXEnhancedUserInterface" as CFString,kCFBooleanTrue)
AXUIElementSetAttributeValue(root,"AXManualAccessibility" as CFString,kCFBooleanTrue)
func snapshot() -> [(Node,AXUIElement)] {
    var nodes = flatten(root)
    // Passive inspection: a missing accessibility tree means the desktop window is
    // unloaded or backgrounded. Report that state without activating Claude.
    if nodes.count < 3 { return nodes }
    for _ in 0..<15 {
        if nodes.count > 25 && nodes.contains(where:{$0.0.role == "AXWebArea"}) { break }
        RunLoop.current.run(until:Date(timeIntervalSinceNow:0.1))
        nodes = flatten(root)
    }
    return nodes
}
func selectedId(_ nodes: [(Node,AXUIElement)]) -> String? {
    for (node,_) in nodes {
        if let range = node.url.range(of:"/epitaxy/") {
            let id = String(node.url[range.upperBound...]).split(separator:"?").first.map(String.init) ?? ""
            if id.range(of:"^local_[A-Za-z0-9_-]+$",options:.regularExpression) != nil { return id }
        }
    }
    return nil
}
func inspect() {
    let nodes = snapshot()
    let encoded = try! JSONEncoder().encode(nodes.map { $0.0 })
    let values = try! JSONSerialization.jsonObject(with:encoded)
    emit(["ok":true,"selectedId":selectedId(nodes) ?? "","nodes":values])
}
func press(_ element: AXUIElement) {
    let result = AXUIElementPerformAction(element,kAXPressAction as CFString)
    if result != .success { fail("Claude 控件未响应，请刷新会话") }
}
func focusApp() {
    app.activate(options: [])
    if let window = children(root).first(where:{text(attribute($0,kAXRoleAttribute)) == kAXWindowRole}) { AXUIElementPerformAction(window,kAXRaiseAction as CFString) }
}
func activeSnapshot() -> [(Node,AXUIElement)] {
    // Explicit desktop mutations may raise Claude, then wait for the UI to load.
    var nodes = snapshot()
    if nodes.count < 3 {
        focusApp()
        for _ in 0..<15 {
            RunLoop.current.run(until:Date(timeIntervalSinceNow:0.1))
            nodes = snapshot()
            if nodes.count >= 3 { break }
        }
    }
    return nodes
}
func checkedSelection(_ nodes: [(Node,AXUIElement)]) {
    guard let id = command["id"] as? String, selectedId(nodes) == id else { fail("Claude 当前打开的会话已改变，未发送操作。请重新打开目标会话。") }
}
switch operation {
case "inspect": inspect()
case "open":
    guard let id = command["id"] as? String, id.range(of:"^local_[A-Za-z0-9_-]+$",options:.regularExpression) != nil else { fail("Invalid Claude session id") }
    guard let url = URL(string:"claude://claude.ai/epitaxy/"+id) else { fail("Invalid session link") }
    NSWorkspace.shared.open(url)
    emit(["ok":true])
case "new":
    focusApp()
    let nodes = activeSnapshot()
    if selectedId(nodes) == nil, let prompt = nodes.first(where:{$0.0.description == "Prompt"}), !prompt.0.value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty { fail("Claude 新建页面已有草稿，请先处理草稿再新建") }
    // Use Claude's supported local-session deep link to open its own new-chat UI.
    guard let url = URL(string:"claude://claude.ai/epitaxy") else { fail("Invalid Claude link") }
    NSWorkspace.shared.open(url)
    emit(["ok":true])
case "send":
    let nodes = activeSnapshot()
    if command["new"] as? Bool != true { checkedSelection(nodes) } else if selectedId(nodes) != nil { fail("Claude 新建页面已变化，未发送操作") }
    guard let message = command["text"] as? String, !message.isEmpty, message.count <= 131072 else { fail("Invalid message") }
    guard let prompt = nodes.first(where:{[kAXTextAreaRole,kAXTextFieldRole].contains($0.0.role) && ($0.0.description == "Prompt" || $0.0.title == "Prompt")}) else { fail("Claude 输入框尚未就绪，请先选择运行环境") }
    // Preserve an unsent local draft instead of replacing it from another device.
    guard prompt.0.value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else { fail("Claude 桌面输入框已有草稿，请先处理草稿再从远端发送") }
    focusApp()
    AXUIElementSetAttributeValue(prompt.1,kAXFocusedAttribute as CFString,kCFBooleanTrue)
    if let paths = command["images"] as? [String], !paths.isEmpty {
        guard paths.count <= 4 else { fail("最多附加 4 张图片") }
        for path in paths {
            let attachmentRoot = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/state/native-desktop-bridge/attachments/").path + "/"
            guard path.hasPrefix(attachmentRoot), !path.dropFirst(attachmentRoot.count).contains("/"), let image = NSImage(contentsOfFile:path) else { fail("图片附件不存在或无法打开") }
            let pasteboard = NSPasteboard.general
            let saved = (pasteboard.pasteboardItems ?? []).map { item in item.types.compactMap { type in item.data(forType:type).map { (type,$0) } } }
            pasteboard.clearContents()
            pasteboard.writeObjects([image])
            let ownedChange = pasteboard.changeCount
            let down = CGEvent(keyboardEventSource:nil,virtualKey:9,keyDown:true)
            let up = CGEvent(keyboardEventSource:nil,virtualKey:9,keyDown:false)
            down?.flags = .maskCommand; up?.flags = .maskCommand
            down?.postToPid(pid); up?.postToPid(pid)
            RunLoop.current.run(until:Date(timeIntervalSinceNow:0.6))
            if pasteboard.changeCount == ownedChange {
                pasteboard.clearContents()
                let restored = saved.map { values -> NSPasteboardItem in let item=NSPasteboardItem(); for (type,data) in values { item.setData(data,forType:type) }; return item }
                pasteboard.writeObjects(restored)
            }
        }
    }
    guard AXUIElementSetAttributeValue(prompt.1,kAXValueAttribute as CFString,message as CFString) == .success else { fail("Claude 输入框拒绝写入") }
    var sendButtons: [(Node,AXUIElement)] = []
    for _ in 0..<8 {
        RunLoop.current.run(until:Date(timeIntervalSinceNow:0.08))
        sendButtons = snapshot().filter{$0.0.role == kAXButtonRole && ($0.0.title == "Send" || $0.0.description == "Send")}
        if sendButtons.count == 1 { break }
    }
    guard sendButtons.count == 1 else { fail("消息已填入 Claude 草稿，但发送按钮尚未就绪，请在桌面确认") }
    press(sendButtons[0].1)
    emit(["ok":true,"dispatched":true])
case "pin":
    let nodes = activeSnapshot(); checkedSelection(nodes)
    guard let pinned = command["pinned"] as? Bool else { fail("Invalid pin state") }
    let labels = pinned ? ["Pin", "置顶"] : ["Unpin", "取消置顶"]
    guard let title = command["title"] as? String else { fail("会话标题缺失") }
    let rows = nodes.filter { $0.0.role == kAXButtonRole && $0.0.title == title }
    guard rows.count == 1 else { fail("找不到唯一的 Claude 原会话菜单，请在桌面打开它") }
    AXUIElementPerformAction(rows[0].1,kAXShowMenuAction as CFString)
    RunLoop.current.run(until:Date(timeIntervalSinceNow:0.2))
    let targets = snapshot().filter { $0.0.role == kAXMenuItemRole && labels.contains($0.0.title.isEmpty ? $0.0.description : $0.0.title) }
    guard targets.count == 1 else { fail("Claude 原生置顶菜单暂不可用，未修改本地会话文件") }
    press(targets[0].1)
    emit(["ok":true,"dispatched":true])
case "archive":
    let nodes = activeSnapshot(); checkedSelection(nodes)
    guard let archived = command["archived"] as? Bool else { fail("Invalid archive state") }
    let labels = archived ? ["Archive", "Archive session", "Archive chat", "归档"] : ["Unarchive", "Unarchive session", "Restore", "Restore session", "恢复会话", "取消归档"]
    var targets = nodes.filter { [kAXButtonRole,kAXMenuItemRole].contains($0.0.role) && labels.contains($0.0.title.isEmpty ? $0.0.description : $0.0.title) }
    if targets.count != 1 {
        guard let title = command["title"] as? String else { fail("会话标题缺失") }
        let rows = nodes.filter { $0.0.role == kAXButtonRole && $0.0.title == title }
        guard rows.count == 1 else { fail("找不到唯一的 Claude 原会话菜单，请在桌面打开它") }
        AXUIElementPerformAction(rows[0].1,kAXShowMenuAction as CFString)
        RunLoop.current.run(until:Date(timeIntervalSinceNow:0.2))
        targets = snapshot().filter { [kAXButtonRole,kAXMenuItemRole].contains($0.0.role) && labels.contains($0.0.title.isEmpty ? $0.0.description : $0.0.title) }
    }
    guard targets.count == 1 else { fail("Claude 原生归档菜单暂不可用，未修改本地会话文件") }
    press(targets[0].1)
    emit(["ok":true,"dispatched":true])
case "stop":
    let nodes = activeSnapshot(); checkedSelection(nodes)
    guard let button = nodes.first(where:{$0.0.role == kAXButtonRole && ["Stop","Stop response","Stop generating","停止"].contains($0.0.title.isEmpty ? $0.0.description : $0.0.title)}) else { fail("这个 Claude 会话当前没有可停止的运行轮次") }
    press(button.1); emit(["ok":true,"stopped":true])
case "respond":
    let nodes = activeSnapshot(); checkedSelection(nodes)
    let allowed = ["Allow","Allow once","Allow this time","Approve","Reject","Deny","拒绝","允许","允许一次"]
    guard let title = command["button"] as? String, allowed.contains(title) else { fail("Unsupported approval response") }
    let buttons = nodes.filter{$0.0.role == kAXButtonRole && $0.0.title == title}
    guard buttons.count == 1 else { fail("审批按钮已变化，请刷新") }
    press(buttons[0].1); emit(["ok":true])
default: fail("Unsupported desktop action")
}

}
while let line = readLine() {
    guard let data = line.data(using:.utf8), let command = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else { fail("Invalid desktop command") }
    handle(command)
}

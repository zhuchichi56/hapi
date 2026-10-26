import * as Popover from '@radix-ui/react-popover'

export function CopyLinkIcon() {
    return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>
}

export function ThreadActions({ title, pinned, archived, onPin, onCopy, onArchive }: { title: string; pinned: boolean; archived: boolean; onPin: () => void; onCopy: () => void; onArchive: () => void }) {
    return <Popover.Root>
        <Popover.Trigger asChild><button type="button" className="nd-menu-trigger" aria-label={`更多操作：${title}`} title="更多操作">⋯</button></Popover.Trigger>
        <Popover.Portal><Popover.Content className="nd-thread-menu" aria-label="会话操作" side="bottom" align="end" sideOffset={4} collisionPadding={10}>
            <Popover.Close asChild><button type="button" onClick={onCopy}><CopyLinkIcon />复制会话链接</button></Popover.Close>
            <Popover.Close asChild><button type="button" onClick={onPin} aria-label={`${pinned ? '取消置顶' : '置顶'}：${title}（此浏览器）`}><span aria-hidden="true">↟</span>{pinned ? '取消置顶' : '置顶会话'}</button></Popover.Close>
            <div className="nd-menu-divider" />
            <Popover.Close asChild><button type="button" onClick={onArchive} title="仅整理此浏览器的列表，原桌面会话保留"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 8v12h16V8M3 4h18v4H3zM9 12h6" /></svg>{archived ? '恢复到最近' : '归档会话'}</button></Popover.Close>
            <small>归档和置顶保存在此浏览器</small>
        </Popover.Content></Popover.Portal>
    </Popover.Root>
}

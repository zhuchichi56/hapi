# Desktop operation mapping audit — 2026-10-27

Conversation and task mutations use the original desktop Apps. The web page does not maintain replacement pin/archive state or start an independent CLI conversation. Both adapters retain the original session ID. Successful organization changes are shown only after native acknowledgement; failed or uncertain writes are not replayed.

| Operation | Original-client path | Evidence |
| --- | --- | --- |
| Read history / tools / images | Codex original IPC/read_thread; Claude original runtime transcript | Previously verified original histories; native IDs retained |
| Create chat / select a new-chat model | Codex original create_thread/model catalog; Claude original new-session UI/default model | Existing real create/model/image acceptance records |
| Send / image / follow-up | Codex owner start-turn with original ID and localImage; Claude original input/Send/native queue | Both Apps real image replies; Claude queue acceptance and both original replies verified |
| Pin / unpin | Codex set_thread_pinned; Claude original Pin/Unpin menu, confirmed isStarred metadata | Both directions verified against both original Apps; original list readback confirms pin state |
| Archive / restore | Codex set_thread_archived; Claude original menu and isArchived metadata | Public web archive and restore previously verified for both Apps |
| Stop | Codex interrupt original owner + expected native turn; Claude original Stop control | Codex prior active→interrupted check; this run Claude observed active→native Stop→idle |
| Approval choices | Codex original pending request ID/owner; Claude original session approval button | Focused adapter fixtures verify exact original target and stale-choice rejection; a live approval dialog was not triggered in this run |
| Copy conversation link | Original Codex/Claude deep link, with separate web-link option | Original link formats verified; clipboard belongs to the device using the web page |
| Search / scrolling / folded tools / image preview / unsent draft | Local reading/input state | No conversation/task mutation is claimed until a native action is submitted |

## Changes from the earlier browser-only behavior

- Pin and unpin now change the actual desktop App.
- The frontend ignores old browser pin/archive flags; it neither bulk applies nor deletes those saved flags. The original App decides what is pinned, recent or archived.
- The native page no longer links back into the separate HAPI session UI.
- The scoped AGENTS.md records this rule for future changes. Native operation errors are kept; there is no silent local-only fallback.

## Verification boundaries

- 23 focused adapter tests and 17 focused route tests passed; Web/Hub typechecks, Swift compilation, production build and embedded Hub compile passed.
- Dedicated acceptance chats are used and their pin/archive organization is restored afterward. No live research chat was stopped or approved.
- Public pin and unpin both returned native acknowledgements. Original Codex lists confirmed the real pin transition and restoration. A transient page read error appeared while a mutation was pending, but both mutation responses subsequently succeeded; no write was replayed.
- Claude UI actions still require an unlocked desktop and can switch its selected session. Reading/search/scrolling in the browser need not mirror the desktop viewport. This integration does not control ordinary ChatGPT conversations.

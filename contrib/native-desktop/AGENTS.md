# Native desktop integration contract

- This integration controls the user's original Codex and Claude Code desktop conversations. All conversation/task mutations must call the original App and use the original session identity.
- Pin/unpin, archive/restore, send/create, stop and approval actions must never fall back to browser-only state, independent CLI sessions or a replacement conversation database. Update visible mutation state only after the original adapter confirms acceptance; keep failures visible and do not replay uncertain writes.
- Lists and status come from the original clients. Ignore legacy browser pin/archive overrides instead of bulk applying them to native sessions.
- Search, scroll, folding, link copying and unsent attachment previews are local presentation/input controls; they must not invent native state changes. The native desktop page must not navigate users into independent HAPI sessions.
- Test mutations on dedicated HAPI acceptance chats and restore their organization state afterward. Separate real-client checks from protocol fixtures; do not claim a live approval dialog was verified when only fixtures ran.

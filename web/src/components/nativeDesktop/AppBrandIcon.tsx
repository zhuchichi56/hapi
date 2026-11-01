import ClaudeLogo from '@lobehub/icons/es/Claude/components/Mono'
import OpenAILogo from '@lobehub/icons/es/OpenAI/components/Mono'

export function AppBrandIcon({ app }: { app: string }) {
    const Logo = app === 'codex' ? OpenAILogo : ClaudeLogo
    return <span aria-hidden="true" className="nd-avatar-logo"><Logo size="100%" /></span>
}

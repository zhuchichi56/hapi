import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { AuthRequestSchema } from '@hapi/protocol'
import { getConfiguration } from '../../configuration'
import {
    resolveWebAccessLogin,
    WebAccessConfigError
} from '../../utils/webAccessCodes'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../../config/ownerId'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'

export function createAuthRoutes(jwtSecret: Uint8Array, store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/auth', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = AuthRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        let userId: number
        let username: string | undefined
        let firstName: string | undefined
        let lastName: string | undefined
        let namespace: string

        // Opaque web access codes (preferred) or legacy CLI_API_TOKEN parsing.
        // The registry is re-read on every login so codes can be revoked
        // without a rebuild. A malformed/insecure registry fails closed.
        if ('accessToken' in parsed.data) {
            const configuration = getConfiguration()

            let login: ReturnType<typeof resolveWebAccessLogin>
            try {
                login = resolveWebAccessLogin(
                    configuration.dataDir,
                    configuration.cliApiToken,
                    parsed.data.accessToken
                )
            } catch (error) {
                if (error instanceof WebAccessConfigError) {
                    return c.json({ error: 'Web access is temporarily unavailable' }, 503)
                }
                throw error
            }

            if (!login.ok) {
                return c.json({ error: 'Invalid access token' }, 401)
            }

            userId = await getOrCreateOwnerId()
            firstName = 'Web User'
            namespace = login.namespace
        } else {
            const configuration = getConfiguration()
            if (!configuration.telegramEnabled || !configuration.telegramBotToken) {
                return c.json({ error: 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' }, 503)
            }

            // Telegram initData authentication
            const result = validateTelegramInitData(parsed.data.initData, configuration.telegramBotToken)
            if (!result.ok) {
                return c.json({ error: result.error }, 401)
            }

            const telegramUserId = String(result.user.id)
            const storedUser = store.users.getUser('telegram', telegramUserId)
            if (!storedUser) {
                return c.json({ error: 'not_bound' }, 401)
            }

            userId = await getOrCreateOwnerId()
            username = result.user.username
            firstName = result.user.first_name
            lastName = result.user.last_name
            namespace = storedUser.namespace
        }

        const token = await new SignJWT({ uid: userId, ns: namespace })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('4h')
            .sign(jwtSecret)

        return c.json({
            token,
            user: {
                id: userId,
                username,
                firstName,
                lastName
            }
        })
    })

    return app
}

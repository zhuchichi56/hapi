import * as webPush from 'web-push'
import type { Store } from '../store'
import type { VapidKeys } from '../config/vapidKeys'

/**
 * `web-push` sends with node:https, which does not honour HTTP(S)_PROXY under
 * Bun 1.4.2 (verified: env-only sends go direct). The library has a supported
 * `proxy` option (https-proxy-agent), so pass the egress proxy explicitly.
 * Fail closed: if the proxy is configured and unavailable, the send fails and
 * is logged; there is no direct fallback (the mini has no default route).
 */
function resolveWebPushProxy(): string | null {
    const names = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'] as const
    for (const name of names) {
        const value = process.env[name]?.trim()
        if (value) {
            return value
        }
    }
    return null
}

const WEB_PUSH_TIMEOUT_MS = 15_000

export type PushPayload = {
    title: string
    body: string
    tag?: string
    data?: {
        type: string
        sessionId: string
        url: string
        /** First pending request id; input-request uses it for correlation, never approval. */
        requestId?: string
    }
}

type StoredSubscription = {
    endpoint: string
    p256dh: string
    auth: string
}

type PushSubscription = {
    endpoint: string
    keys: {
        p256dh: string
        auth: string
    }
}

export class PushService {
    private readonly webPushProxy = resolveWebPushProxy()

    constructor(
        private readonly vapidKeys: VapidKeys,
        private readonly subject: string,
        private readonly store: Store
    ) {
        webPush.setVapidDetails(this.subject, this.vapidKeys.publicKey, this.vapidKeys.privateKey)
    }

    async sendToNamespace(namespace: string, payload: PushPayload): Promise<void> {
        const subscriptions = this.store.push.getPushSubscriptionsByNamespace(namespace)
        if (subscriptions.length === 0) {
            return
        }

        const body = JSON.stringify(payload)
        await Promise.all(subscriptions.map((subscription) => {
            return this.sendToSubscription(namespace, subscription, body)
        }))
    }

    private async sendToSubscription(
        namespace: string,
        subscription: StoredSubscription,
        body: string
    ): Promise<void> {
        const pushSubscription: PushSubscription = {
            endpoint: subscription.endpoint,
            keys: {
                p256dh: subscription.p256dh,
                auth: subscription.auth
            }
        }

        try {
            await webPush.sendNotification(pushSubscription, body, {
                timeout: WEB_PUSH_TIMEOUT_MS,
                ...(this.webPushProxy ? { proxy: this.webPushProxy } : {})
            })
        } catch (error) {
            const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
                ? (error as { statusCode: number }).statusCode
                : null

            if (statusCode === 410) {
                this.store.push.removePushSubscription(namespace, subscription.endpoint)
                return
            }

            console.error('[PushService] Failed to send notification:', error)
        }
    }
}

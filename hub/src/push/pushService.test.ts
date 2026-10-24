import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'

/**
 * Focused regression for the deployed web-push proxy fix.
 *
 * `web-push` is fully mocked: no VAPID signing, no network, no real
 * subscriptions. The test locks in the three deployment-critical behaviours:
 *   1. a configured proxy is passed through web-push's supported `proxy` option
 *   2. with no proxy env, the `proxy` option is omitted (unchanged behaviour)
 *   3. a 410 Gone response still removes the subscription for its namespace
 */

type StoredSubscription = {
    endpoint: string
    p256dh: string
    auth: string
}

type WebPushCall = [
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    body: string,
    options: { timeout?: number; proxy?: string }
]

let sendImplementation: (...args: unknown[]) => Promise<void> = async () => {}

const sendNotification = mock((...args: unknown[]) => sendImplementation(...args))
const setVapidDetails = mock((..._args: unknown[]) => {})

mock.module('web-push', () => ({
    sendNotification,
    setVapidDetails,
    default: { sendNotification, setVapidDetails }
}))

const { PushService } = await import('./pushService')

const PROXY_ENV_KEYS = [
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'HTTP_PROXY',
    'http_proxy'
] as const

const savedProxyEnv = new Map<string, string | undefined>()
for (const key of PROXY_ENV_KEYS) {
    savedProxyEnv.set(key, process.env[key])
    delete process.env[key]
}

const vapidKeys = {
    publicKey: 'test-public-key',
    privateKey: 'test-private-key'
}
const subject = 'mailto:test@example.invalid'

function createSubscription(
    endpoint = 'https://push.example.invalid/subscription-1'
): StoredSubscription {
    return {
        endpoint,
        p256dh: 'test-p256dh',
        auth: 'test-auth'
    }
}

function createStore(subscriptions: StoredSubscription[]) {
    const removedSubscriptions: Array<{ namespace: string; endpoint: string }> = []
    const getPushSubscriptionsByNamespace = mock((_namespace: string) => subscriptions)
    const removePushSubscription = mock((namespace: string, endpoint: string) => {
        removedSubscriptions.push({ namespace, endpoint })
    })

    return {
        store: {
            push: {
                getPushSubscriptionsByNamespace,
                removePushSubscription
            }
        },
        removedSubscriptions,
        getPushSubscriptionsByNamespace,
        removePushSubscription
    }
}

function createService(store: ReturnType<typeof createStore>['store']) {
    return new PushService(vapidKeys as never, subject, store as never)
}

function webPushCall(): WebPushCall {
    const call = sendNotification.mock.calls[0]
    if (!call) {
        throw new Error('web-push sendNotification was not called')
    }
    return call as WebPushCall
}

beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
        delete process.env[key]
    }
    sendImplementation = async () => {}
    sendNotification.mockClear()
    setVapidDetails.mockClear()
})

afterAll(() => {
    for (const [key, value] of savedProxyEnv) {
        if (value === undefined) {
            delete process.env[key]
        } else {
            process.env[key] = value
        }
    }
})

describe('PushService web-push proxy', () => {
    it('passes the configured HTTPS proxy and timeout to web-push', async () => {
        process.env.HTTPS_PROXY = '  http://127.0.0.1:18080  '
        const subscription = createSubscription()
        const {
            store,
            getPushSubscriptionsByNamespace
        } = createStore([subscription])
        const service = createService(store)
        const payload = {
            title: 'Task finished',
            body: 'Focused regression',
            data: {
                type: 'task',
                sessionId: 'session-1',
                url: '/sessions/session-1'
            }
        }

        await service.sendToNamespace('team-alpha', payload)

        expect(setVapidDetails).toHaveBeenCalledWith(
            subject,
            vapidKeys.publicKey,
            vapidKeys.privateKey
        )
        expect(getPushSubscriptionsByNamespace).toHaveBeenCalledWith('team-alpha')
        expect(sendNotification).toHaveBeenCalledTimes(1)

        const [pushSubscription, body, options] = webPushCall()
        expect(pushSubscription).toEqual({
            endpoint: subscription.endpoint,
            keys: {
                p256dh: subscription.p256dh,
                auth: subscription.auth
            }
        })
        expect(JSON.parse(body)).toEqual(payload)
        expect(options).toEqual({
            timeout: 15_000,
            proxy: 'http://127.0.0.1:18080'
        })
    })

    it('omits the proxy option when no proxy env is set', async () => {
        const subscription = createSubscription()
        const { store } = createStore([subscription])
        const service = createService(store)

        await service.sendToNamespace('default', { title: 'No proxy', body: 'Direct' })

        expect(sendNotification).toHaveBeenCalledTimes(1)
        const [, , options] = webPushCall()
        expect(options).toEqual({ timeout: 15_000 })
        expect('proxy' in options).toBe(false)
    })

    it('removes the subscription on 410 Gone without logging an error', async () => {
        const subscription = createSubscription(
            'https://push.example.invalid/gone-subscription'
        )
        const {
            store,
            removePushSubscription
        } = createStore([subscription])
        const service = createService(store)
        const gone = Object.assign(new Error('Gone'), { statusCode: 410 })

        sendImplementation = async () => {
            throw gone
        }

        const logged: unknown[][] = []
        const originalConsoleError = console.error
        console.error = (...args: unknown[]) => {
            logged.push(args)
        }

        try {
            await service.sendToNamespace('team-gone', {
                title: 'Gone',
                body: 'Cleanup'
            })
        } finally {
            console.error = originalConsoleError
        }

        expect(sendNotification).toHaveBeenCalledTimes(1)
        expect(removePushSubscription).toHaveBeenCalledTimes(1)
        expect(removePushSubscription).toHaveBeenCalledWith(
            'team-gone',
            subscription.endpoint
        )
        expect(logged).toHaveLength(0)
    })
})

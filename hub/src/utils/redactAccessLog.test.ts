import { expect, test } from 'bun:test'
import { redactAccessLog } from './redactAccessLog'

test('redacts credentials in request query strings while retaining request context', () => {
    expect(redactAccessLog('GET /api/events?token=test-jwt&namespace=wwx 200'))
        .toBe('GET /api/events?token=[REDACTED]&namespace=wwx 200')
    expect(redactAccessLog('GET /voice?language=zh&apiKey=test-key&token=other 200'))
        .toBe('GET /voice?language=zh&apiKey=[REDACTED]&token=[REDACTED] 200')
    expect(redactAccessLog('GET /health 200')).toBe('GET /health 200')
})

/** Hono request URLs may carry EventSource JWTs; never persist those values. */
export function redactAccessLog(message: string): string {
    return message.replace(/([?&](?:token|access_token|accessToken|apiKey|api_key|key)=)[^&\s]*/gi, '$1[REDACTED]')
}

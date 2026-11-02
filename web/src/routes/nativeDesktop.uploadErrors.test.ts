import { describe, expect, it } from 'vitest'
import { attachmentUploadError } from './nativeDesktop'

describe('ZIP upload error messages', () => {
    it('describes an upload timeout without calling it a desktop disconnection', () => {
        expect(attachmentUploadError({ status: 524, body: '<html>gateway timeout</html>' })).toBe('附件上传超时，请重试')
        expect(attachmentUploadError(new DOMException('Timed out', 'TimeoutError'))).toBe('附件上传超时，请重试')
    })
    it('preserves the server validation error and gives a useful network error', () => {
        expect(attachmentUploadError({ status: 400, body: '{"error":"ZIP 文件格式无效"}' })).toBe('ZIP 文件格式无效')
        expect(attachmentUploadError(new TypeError('Failed to fetch'))).toBe('附件上传失败，请检查网络后重试')
    })
})

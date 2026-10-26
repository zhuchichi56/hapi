export type DraftImage = { name: string; data: string }

export async function prepareImage(file: File): Promise<DraftImage> {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw Error('请选择 PNG、JPEG、WebP 或 GIF 图片')
    if (file.size > 20 * 1024 * 1024) throw Error('单张原图不能超过 20 MB')
    const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(Error('图片读取失败'))
        reader.readAsDataURL(file)
    })
    const image = new Image()
    image.src = source
    await image.decode().catch(() => { throw Error('这张图片无法打开') })
    if (file.size <= 1024 * 1024 && Math.max(image.width, image.height) <= 2048 && file.type !== 'image/gif') return { name: file.name, data: source }
    const scale = Math.min(1, 2048 / Math.max(image.width, image.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw Error('无法处理图片，请重试')
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    for (const quality of [0.9, 0.78, 0.6, 0.42]) {
        const data = canvas.toDataURL('image/jpeg', quality)
        if (data.length <= 1398200) return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', data }
    }
    throw Error('图片压缩后仍过大，请裁剪后重试')
}

import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

export async function withFileDescriptor(path, use) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const details = await file.stat()
    return await use(file, details)
  } finally { await file.close() }
}

export async function boundedFile(path, maxBytes, invalid, onRead) {
  return withFileDescriptor(path, async (file, before) => {
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) throw invalid()
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw invalid()
      offset += bytesRead
    }
    const after = await file.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw invalid()
    await onRead?.(bytes, file, after)
    return bytes
  })
}

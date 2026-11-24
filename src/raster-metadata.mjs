// Container and dimension checks only. Pixel decoding is left to the renderer.
const safe = (width, height) => width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 32_000_000

// PNG specification §11.2.1, table 12.
const pngDepths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]])

function png(b) {
  if (b.length < 45 || b.readUInt32BE(8) !== 13 || b.toString('ascii', 12, 16) !== 'IHDR' ||
    !safe(b.readUInt32BE(16), b.readUInt32BE(20))) return false
  if (!pngDepths.get(b[25])?.includes(b[24]) || b[26] !== 0 || b[27] !== 0 || (b[28] !== 0 && b[28] !== 1)) return false
  let data = false
  for (let p = 33; p + 12 <= b.length;) {
    const size = b.readUInt32BE(p)
    const end = p + 12 + size
    const kind = b.toString('ascii', p + 4, p + 8)
    if (end > b.length) return false
    if (kind === 'IDAT' && size) data = true
    if (kind === 'IEND') return size === 0 && data && end === b.length
    if (kind === 'IHDR' || (kind === 'fcTL' && (size !== 26 || !safe(b.readUInt32BE(p + 12), b.readUInt32BE(p + 16))))) return false
    p = end
  }
  return false
}

function gif(b) {
  if (b.length < 14 || !safe(b.readUInt16LE(6), b.readUInt16LE(8))) return false
  const tableSize = flags => flags & 128 ? 3 * (2 << (flags & 7)) : 0
  let p = 13 + tableSize(b[10])
  let image = false
  while (p < b.length) {
    const tag = b[p++]
    if (tag === 0x3b) return image && p === b.length
    if (tag === 0x21 && p < b.length) p++
    else if (tag === 0x2c && p + 10 <= b.length) {
      if (!safe(b.readUInt16LE(p + 4), b.readUInt16LE(p + 6))) return false
      p += 9 + tableSize(b[p + 8])
      if (p + 1 >= b.length || b[p] < 2 || b[p] > 8 || !b[p + 1]) return false
      p++
      image = true
    } else return false
    while (p < b.length && b[p]) p += 1 + b[p]
    if (p >= b.length) return false
    p++
  }
  return false
}

const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
function jpeg(b) {
  let frame = false
  let scan = false
  for (let p = 2; p < b.length;) {
    if (b[p++] !== 0xff) return false
    while (b[p] === 0xff) p++
    const marker = b[p++]
    if (marker === 0xd9) return frame && scan
    if (p + 2 > b.length || marker === 0 || marker === 0xd8) return false
    const size = b.readUInt16BE(p)
    if (size < 2 || p + size > b.length) return false
    if (frameMarkers.has(marker)) {
      if (size < 11 || !safe(b.readUInt16BE(p + 5), b.readUInt16BE(p + 3))) return false
      frame = true
    }
    p += size
    if (marker !== 0xda) continue
    if (!frame || size < 8) return false
    const start = p
    while (p < b.length) {
      if (b[p] !== 0xff) p++
      else if (b[p + 1] === 0 || (b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7)) p += 2
      else break
    }
    if (p === start) return false
    scan = true
  }
  return false
}

function webp(b) {
  if (b.length < 20 || b.readUInt32LE(4) + 8 !== b.length) return false
  function chunks(start, end, frame = false) {
    let image = false
    for (let p = start; p < end;) {
      if (p + 8 > end) return false
      const kind = b.toString('ascii', p, p + 4)
      const size = b.readUInt32LE(p + 4)
      const body = p + 8
      p = body + size + (size & 1)
      if (p > end) return false
      if (kind === 'VP8X' && (frame || size !== 10 ||
        !safe(b.readUIntLE(body + 4, 3) + 1, b.readUIntLE(body + 7, 3) + 1))) return false
      if (kind === 'VP8 ') {
        if (size <= 10 || (b[body] & 1) || b.readUIntBE(body + 3, 3) !== 0x9d012a ||
          !safe(b.readUInt16LE(body + 6) & 0x3fff, b.readUInt16LE(body + 8) & 0x3fff)) return false
        image = true
      }
      if (kind === 'VP8L') {
        if (size <= 5 || b[body] !== 0x2f) return false
        const bits = b.readUInt32LE(body + 1)
        if (bits >>> 29 || !safe((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)) return false
        image = true
      }
      if (kind === 'ANMF') {
        if (frame || size < 24 || !safe(b.readUIntLE(body + 6, 3) + 1, b.readUIntLE(body + 9, 3) + 1) ||
          !chunks(body + 16, body + size, true)) return false
        image = true
      }
    }
    return image
  }
  return chunks(12, b.length)
}

export function rasterMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && png(bytes)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && jpeg(bytes)) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) && gif(bytes)) return 'image/gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && webp(bytes)) return 'image/webp'
}

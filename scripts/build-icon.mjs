import sharp from 'sharp'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const buildDir = join(__dirname, '..', 'build')
const svgPath = join(buildDir, 'icon.svg')
const icoPath = join(buildDir, 'icon.ico')

const sizes = [16, 24, 32, 48, 64, 128, 256]
const svg = readFileSync(svgPath)

const frames = await Promise.all(
  sizes.map(async (size) => ({
    size,
    data: await sharp(svg, { density: 384 })
      .resize(size, size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer()
  }))
)

// Build ICO with PNG payloads at every size (Vista+). Sidesteps the BMP-in-ICO
// AND-mask trap where Windows shell paths render the icon opaque against white.
function buildPngIco(frames) {
  const headerSize = 6
  const entriesSize = 16 * frames.length
  const header = Buffer.alloc(headerSize + entriesSize)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = ICO
  header.writeUInt16LE(frames.length, 4)

  let dataOffset = headerSize + entriesSize
  const chunks = []

  for (let i = 0; i < frames.length; i++) {
    const { size, data } = frames[i]
    const off = headerSize + i * 16
    header[off] = size === 256 ? 0 : size
    header[off + 1] = size === 256 ? 0 : size
    header[off + 2] = 0 // palette
    header[off + 3] = 0 // reserved
    header.writeUInt16LE(1, off + 4) // planes
    header.writeUInt16LE(32, off + 6) // bpp
    header.writeUInt32LE(data.length, off + 8)
    header.writeUInt32LE(dataOffset, off + 12)
    chunks.push(data)
    dataOffset += data.length
  }

  return Buffer.concat([header, ...chunks])
}

const ico = buildPngIco(frames)
writeFileSync(icoPath, ico)

console.log(`Wrote ${icoPath} — ${sizes.join('/')} px (PNG-in-ICO), ${ico.length} bytes`)

import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { probeImage } from '../src/image.ts'
import { PNG } from './support/memory-client.ts'

describe('read-path raster probe', () => {
  it('re-derives the intrinsic metadata of every accepted format', async () => {
    const canvas = { create: { width: 3, height: 2, channels: 3 as const, background: { r: 9, g: 9, b: 9 } } }
    const cases = [
      { data: PNG, mediaType: 'image/png', width: 1, height: 1 },
      { data: new Uint8Array(await sharp(canvas).jpeg().toBuffer()), mediaType: 'image/jpeg', width: 3, height: 2 },
      { data: new Uint8Array(await sharp(canvas).webp().toBuffer()), mediaType: 'image/webp', width: 3, height: 2 },
      { data: new Uint8Array(await sharp(canvas).gif().toBuffer()), mediaType: 'image/gif', width: 3, height: 2 },
    ]
    for (const { data, ...expected } of cases) {
      await expect(probeImage(data)).resolves.toEqual(expected)
    }
  })

  it('rejects bytes that are not a supported raster', async () => {
    await expect(probeImage(Uint8Array.of(1, 2, 3))).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })

  it('rejects a raster in a format the attachment seam does not carry', async () => {
    const tiff = new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 1, b: 1 } } }).tiff().toBuffer())
    await expect(probeImage(tiff)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })
})

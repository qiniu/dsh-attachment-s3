import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { detectImage, probeImage } from '../src/image.ts'
import { PNG } from './support/memory-client.ts'

describe('raster inspection', () => {
  it('detects the intrinsic metadata of every accepted format', async () => {
    const canvas = { create: { width: 3, height: 2, channels: 3 as const, background: { r: 9, g: 9, b: 9 } } }
    const cases = [
      { data: PNG, mediaType: 'image/png', width: 1, height: 1 },
      { data: new Uint8Array(await sharp(canvas).jpeg().toBuffer()), mediaType: 'image/jpeg', width: 3, height: 2 },
      { data: new Uint8Array(await sharp(canvas).webp().toBuffer()), mediaType: 'image/webp', width: 3, height: 2 },
      { data: new Uint8Array(await sharp(canvas).gif().toBuffer()), mediaType: 'image/gif', width: 3, height: 2 },
    ]
    for (const { data, ...expected } of cases) {
      await expect(detectImage(data)).resolves.toEqual(expected)
      await expect(probeImage(data)).resolves.toEqual(expected)
    }
  })

  it('rejects bytes that are not a supported raster', async () => {
    await expect(detectImage(Uint8Array.of(1, 2, 3))).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(probeImage(Uint8Array.of(1, 2, 3))).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })

  it('rejects a raster in a format the attachment seam does not carry', async () => {
    const tiff = new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 1, b: 1 } } }).tiff().toBuffer())
    await expect(detectImage(tiff)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(probeImage(tiff)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })

  it('rejects a decoded raster over the pixel limit and admits one at the limit', async () => {
    await expect(detectImage(PNG, { maxPixels: 0 })).rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
    await expect(detectImage(PNG, { maxPixels: 1 })).resolves.toMatchObject({ width: 1, height: 1 })
  })

  it('rejects a raster whose longest side exceeds the per-side limit', async () => {
    const wide = new Uint8Array(await sharp({ create: { width: 8, height: 2, channels: 3, background: { r: 1, g: 1, b: 1 } } }).png().toBuffer())
    await expect(detectImage(wide, { maxDimension: 4 })).rejects.toMatchObject({ code: 'IMAGE_DIMENSION_TOO_LARGE' })
    await expect(detectImage(wide, { maxDimension: 8 })).resolves.toMatchObject({ width: 8, height: 2 })
    // The pixel budget alone would admit it: the per-side limit is its own gate.
    await expect(detectImage(wide, { maxPixels: 1000, maxDimension: 4 })).rejects.toMatchObject({ code: 'IMAGE_DIMENSION_TOO_LARGE' })
  })

  it('probes without applying a pixel limit, since the digest already vouched for the bytes', async () => {
    await expect(probeImage(PNG)).resolves.toMatchObject({ mediaType: 'image/png' })
  })
})

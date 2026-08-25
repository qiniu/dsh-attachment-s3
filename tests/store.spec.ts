import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { ImageAttachmentLimits, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { prepareImageFile } from '@deepseek-ai/dsh-attachment-local'
import type { NormalizationPolicy } from '@deepseek-ai/dsh-attachment-local'
import type { ObjectClient } from '../src/client.ts'
import { objectKey, readImageObject, saveImageObject, validateImageObject } from '../src/store.ts'
import { MemoryObjectClient, PNG } from './support/memory-client.ts'

/** Bound delegation to one memory client, so a spec can replace exactly one operation. */
function delegate(client: MemoryObjectClient): ObjectClient {
  return {
    put: (input, signal) => client.put(input, signal),
    get: (key, options) => client.get(key, options),
    close: () => client.close(),
  }
}

const PREFIX = 'attachments/v1'

const LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 2048,
  maxImagePixels: 16,
  maxImageDimension: 4,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/** Wide enough not to downscale the fixtures, generous enough not to re-encode them. */
const NORMALIZATION: NormalizationPolicy = { maxDimension: 64, maxBytes: 4096 }

// Admission normalizes before storing, so the stored bytes — and the content
// address over them — are not the submitted bytes. Derive both from the same
// helper the store uses.
const STORED = (await prepareImageFile({ data: PNG, mediaType: 'image/png' }, LIMITS, NORMALIZATION)).data
const STORED_SHA256 = createHash('sha256').update(STORED).digest('hex')
const STORED_KEY = objectKey(PREFIX, STORED_SHA256)

function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer()
}

describe('saveImageObject', () => {
  it('publishes one content-addressed object and returns its verified reference', async () => {
    const client = new MemoryObjectClient()
    const ref = await saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png' }, LIMITS, NORMALIZATION)

    expect(ref).toEqual({
      attachmentId: `sha256:${STORED_SHA256}`,
      mediaType: 'image/png',
      bytes: STORED.byteLength,
      width: 1,
      height: 1,
    })
    const stored = client.objects.get(STORED_KEY)
    expect(stored).toMatchObject({
      mediaType: 'image/png',
      checksumSha256: Buffer.from(STORED_SHA256, 'hex').toString('base64'),
      metadata: { width: '1', height: '1' },
    })
    expect(client.objects.size).toBe(1)
  })

  it('keys objects under the configured prefix, fanned out by digest', () => {
    expect(STORED_KEY).toBe(`${PREFIX}/objects/${STORED_SHA256.slice(0, 2)}/${STORED_SHA256}`)
  })

  it('stores the normalized image, not the submitted bytes', async () => {
    const client = new MemoryObjectClient()
    const ref = await saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png' }, LIMITS, NORMALIZATION)

    expect(ref.attachmentId).toBe(`sha256:${STORED_SHA256}`)
    expect(client.objects.get(STORED_KEY)?.data).toEqual(STORED)
  })

  it('converges identical bytes onto one object', async () => {
    const client = new MemoryObjectClient()
    const first = await saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png' }, LIMITS, NORMALIZATION)
    const second = await saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png' }, LIMITS, NORMALIZATION)

    // The content address is what deduplicates: the second save rewrites the
    // same key with the same bytes, so storage holds one object either way.
    expect(second).toEqual(first)
    expect(client.puts).toEqual([STORED_KEY, STORED_KEY])
    expect(client.objects.size).toBe(1)
    expect(client.objects.get(STORED_KEY)?.data).toEqual(STORED)
  })

  it('rejects an image over the byte limit before contacting the store', async () => {
    const client = new MemoryObjectClient()
    await expect(saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png' }, { ...LIMITS, maxImageBytes: 1 }, NORMALIZATION))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    expect(client.puts).toEqual([])
  })

  it('rejects declared metadata that disagrees with the bytes', async () => {
    const client = new MemoryObjectClient()
    await expect(saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/jpeg' }, LIMITS, NORMALIZATION))
      .rejects.toMatchObject({ code: 'IMAGE_TYPE_MISMATCH' })
    await expect(saveImageObject(client, PREFIX, { data: Uint8Array.of(), mediaType: 'image/png' }, LIMITS, NORMALIZATION))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(saveImageObject(client, PREFIX, { data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' }, LIMITS, NORMALIZATION))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    expect(client.puts).toEqual([])
  })

  it('rejects an image over the per-side dimension limit', async () => {
    const client = new MemoryObjectClient()
    const data = new Uint8Array(await sharp({ create: { width: 8, height: 1, channels: 3, background: { r: 4, g: 5, b: 6 } } }).png().toBuffer())
    await expect(saveImageObject(client, PREFIX, { data, mediaType: 'image/png' }, LIMITS, NORMALIZATION))
      .rejects.toMatchObject({ code: 'IMAGE_DIMENSION_TOO_LARGE' })
    expect(client.puts).toEqual([])
  })

  it('rejects an image over the decoded-pixel limit', async () => {
    const client = new MemoryObjectClient()
    const data = new Uint8Array(await jpeg())
    await expect(saveImageObject(client, PREFIX, { data, mediaType: 'image/jpeg' }, { ...LIMITS, maxImagePixels: 3 }, NORMALIZATION))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
    await expect(saveImageObject(client, PREFIX, { data, mediaType: 'image/jpeg' }, LIMITS, NORMALIZATION))
      .resolves.toMatchObject({ mediaType: 'image/jpeg', width: 2, height: 2 })
  })

  it('reports a transport failure as a write failure carrying its cause', async () => {
    const cause = new Error('connection reset')
    const client = new MemoryObjectClient({ faults: { put: cause } })
    await expect(saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png' }, LIMITS, NORMALIZATION))
      .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED', cause })
  })

  it('strips path information and control characters from the display name', async () => {
    const client = new MemoryObjectClient()
    const windows = await saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png', name: 'C:\\Users\\me\\secret\\shot.png' }, LIMITS, NORMALIZATION)
    expect(windows.name).toBe('shot.png')

    const posix = await saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png', name: '/home/me/shot.png' }, LIMITS, NORMALIZATION)
    expect(posix.name).toBe('shot.png')

    const controls = await saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png', name: `sh${String.fromCharCode(0, 9, 27, 127)}ot.png` }, LIMITS, NORMALIZATION)
    expect(controls.name).toBe('shot.png')

    const blank = await saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png', name: '   ' }, LIMITS, NORMALIZATION)
    expect(blank.name).toBeUndefined()

    const long = await saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png', name: `${'a'.repeat(300)}.png` }, LIMITS, NORMALIZATION)
    expect(long.name).toHaveLength(255)
  })
})

describe('readImageObject', () => {
  async function stored(): Promise<{ client: MemoryObjectClient; ref: ImageAttachmentRef }> {
    const client = new MemoryObjectClient()
    const ref = await saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png' }, LIMITS, NORMALIZATION)
    return { client, ref }
  }

  it('returns bytes that still verify against the reference', async () => {
    const { client, ref } = await stored()
    await expect(readImageObject(client, PREFIX, ref)).resolves.toEqual({ ref, data: STORED })
    expect(client.gets).toEqual([STORED_KEY])
  })

  it('reports a missing object rather than an empty read', async () => {
    const { client, ref } = await stored()
    client.objects.clear()
    await expect(readImageObject(client, PREFIX, ref)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
  })

  it('rejects a reference that is not a content address', async () => {
    const { client, ref } = await stored()
    await expect(readImageObject(client, PREFIX, { ...ref, attachmentId: AttachmentId('s3://bucket/key') }))
      .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })
    expect(client.gets).toEqual([])
  })

  it('rejects bytes that no longer hash to the key that named them', async () => {
    const { client, ref } = await stored()
    client.tamper(STORED_KEY, Uint8Array.from(STORED, (byte, index) => (index === STORED.byteLength - 1 ? byte ^ 0xff : byte)))

    await expect(readImageObject(client, PREFIX, ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('rejects verified bytes whose intrinsic metadata disagrees with the reference', async () => {
    const { client, ref } = await stored()
    await expect(readImageObject(client, PREFIX, { ...ref, width: 99 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('bounds the transfer by the length the reference claims', async () => {
    const client = new MemoryObjectClient()
    const ref = await saveImageObject(client, PREFIX, { data: PNG, mediaType: 'image/png' }, LIMITS, NORMALIZATION)
    const seen: number[] = []
    const observed: ObjectClient = {
      ...delegate(client),
      get: async (key, options) => {
        seen.push(options.maxBytes)
        return client.get(key, options)
      },
    }
    await readImageObject(observed, PREFIX, ref)
    expect(seen).toEqual([STORED.byteLength])

    // A stored object longer than the reference comes back longer than the
    // bound and fails verification instead of being truncated into a match.
    client.tamper(STORED_KEY, Uint8Array.from([...STORED, 0]))
    await expect(readImageObject(client, PREFIX, ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('reports a transport failure as a read failure carrying its cause', async () => {
    const { ref } = await stored()
    const cause = new Error('service unavailable')
    const client = new MemoryObjectClient({ faults: { get: cause } })
    await expect(readImageObject(client, PREFIX, ref)).rejects.toMatchObject({ code: 'ATTACHMENT_READ_FAILED', cause })
  })

  it('surfaces the abort reason rather than a storage failure', async () => {
    const { client, ref } = await stored()
    const controller = new AbortController()
    const reason = new Error('caller went away')
    controller.abort(reason)

    await expect(readImageObject(client, PREFIX, ref, controller.signal)).rejects.toBe(reason)
    expect(client.gets).toEqual([])
  })

  it('surfaces the abort reason when cancellation lands during the transfer', async () => {
    const { ref } = await stored()
    const controller = new AbortController()
    const reason = new Error('cancelled mid-transfer')
    const client = new MemoryObjectClient({ faults: { get: new Error('aborted socket') } })
    const aborting: ObjectClient = {
      ...delegate(client),
      get: async (key, options) => {
        controller.abort(reason)
        return client.get(key, options)
      },
    }

    await expect(readImageObject(aborting, PREFIX, ref, controller.signal)).rejects.toBe(reason)
  })
})

describe('validateImageObject', () => {
  it('runs the admission policy without touching storage', async () => {
    const client = new MemoryObjectClient()
    await expect(validateImageObject({ data: PNG, mediaType: 'image/png' }, LIMITS, NORMALIZATION)).resolves.toBeUndefined()
    await expect(validateImageObject({ data: PNG, mediaType: 'image/png' }, { ...LIMITS, maxImageBytes: 1 }, NORMALIZATION))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    await expect(validateImageObject({ data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' }, LIMITS, NORMALIZATION))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    expect(client.objects.size).toBe(0)
    expect(client.puts).toEqual([])
  })
})

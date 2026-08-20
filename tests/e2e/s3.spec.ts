/**
 * Real-bucket round trip. Self-skips without `DSH_S3_E2E_BUCKET`, so a
 * checkout with no bucket still runs the suite green.
 *
 * Required: `DSH_S3_E2E_BUCKET`. Optional: `DSH_S3_E2E_REGION`,
 * `DSH_S3_E2E_ENDPOINT`, `DSH_S3_E2E_FORCE_PATH_STYLE`, `DSH_S3_E2E_PREFIX`.
 * Credentials come from the AWS SDK's own chain.
 *
 * @module tests/e2e/s3
 */

import { createHash, randomBytes } from 'node:crypto'
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Context } from '@deepseek-ai/cordis'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import S3AttachmentStore from '../../src/index.ts'
import { objectKey } from '../../src/store.ts'

const bucket = process.env.DSH_S3_E2E_BUCKET
const region = process.env.DSH_S3_E2E_REGION ?? 'us-east-1'
const endpoint = process.env.DSH_S3_E2E_ENDPOINT
const forcePathStyle = process.env.DSH_S3_E2E_FORCE_PATH_STYLE === 'true'
// A per-run prefix keeps concurrent runs and leftover objects apart.
const prefix = `${process.env.DSH_S3_E2E_PREFIX ?? 'dsh-e2e'}/${randomBytes(6).toString('hex')}`

const written: string[] = []

afterAll(async () => {
  if (bucket === undefined || written.length === 0) return
  const client = rawClient()
  try {
    for (const key of written) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  } finally {
    client.destroy()
  }
})

/**
 * Build a store against the configured bucket.
 * @returns the store under test.
 */
function store(): S3AttachmentStore {
  return new S3AttachmentStore(new Context(), {
    bucket: bucket!,
    region,
    prefix,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(forcePathStyle ? { forcePathStyle } : {}),
  })
}

/**
 * A raw client, used to write past the store's own rules.
 * @returns the client; the caller destroys it.
 */
function rawClient(): S3Client {
  return new S3Client({
    region,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(forcePathStyle ? { forcePathStyle } : {}),
  })
}

describe.skipIf(bucket === undefined)('S3 attachment store against a real bucket', () => {
  it('saves, deduplicates, and reads back one image', async () => {
    const subject = store()
    // Random pixels keep this run's object distinct from every earlier run's,
    // so the dedup assertion measures this test rather than history.
    const data = new Uint8Array(await sharp(randomBytes(48), { raw: { width: 4, height: 4, channels: 3 } }).png().toBuffer())
    written.push(objectKey(prefix, createHash('sha256').update(data).digest('hex')))

    const ref = await subject.saveImage({ data, mediaType: 'image/png', name: 'e2e.png' })
    expect(ref).toMatchObject({ mediaType: 'image/png', bytes: data.byteLength, width: 4, height: 4, name: 'e2e.png' })

    const again = await subject.saveImage({ data, mediaType: 'image/png' })
    expect(again.attachmentId).toBe(ref.attachmentId)

    await expect(subject.readImage(ref)).resolves.toEqual({ ref, data })
  })

  it('rejects a substitution written past the store, on both read and save', async () => {
    const subject = store()
    const data = new Uint8Array(await sharp(randomBytes(48), { raw: { width: 4, height: 4, channels: 3 } }).png().toBuffer())
    const key = objectKey(prefix, createHash('sha256').update(data).digest('hex'))
    written.push(key)

    const ref = await subject.saveImage({ data, mediaType: 'image/png' })

    // An operator, another tool, or a compromised writer replaces the object
    // behind the content address. The overwrite bypasses the conditional
    // write the store itself always sends.
    const raw = rawClient()
    try {
      await raw.send(new PutObjectCommand({
        Bucket: bucket!,
        Key: key,
        Body: Uint8Array.from(data, (byte, index) => (index === data.byteLength - 1 ? byte ^ 0xff : byte)),
      }))
    } finally {
      raw.destroy()
    }

    await expect(subject.readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    await expect(subject.saveImage({ data, mediaType: 'image/png' })).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('reports a reference with no stored object as missing', async () => {
    await expect(store().readImage({
      attachmentId: `sha256:${'0'.repeat(64)}` as never,
      mediaType: 'image/png',
      bytes: 10,
      width: 1,
      height: 1,
    })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
  })
})

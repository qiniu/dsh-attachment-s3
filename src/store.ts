/**
 * Content-addressed attachment storage over the object-store port: admission,
 * write-once publication with dedup verification, and bounded verified reads.
 *
 * @module @qiniu/dsh-attachment-s3/store
 */

import { createHash } from 'node:crypto'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { prepareImageFile, validateImageFile } from '@deepseek-ai/dsh-attachment-local'
import type { NormalizationPolicy } from '@deepseek-ai/dsh-attachment-local'
import { probeImage } from './image.ts'
import type { ObjectClient } from './client.ts'

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function base64Digest(sha256Hex: string): string {
  return Buffer.from(sha256Hex, 'hex').toString('base64')
}

/**
 * Full key of one content-addressed object.
 * @param prefix - configured key prefix without a trailing slash.
 * @param sha256 - lowercase hex digest of the stored bytes.
 * @returns the object key, fanned out one level so a bucket listing stays browsable.
 */
export function objectKey(prefix: string, sha256: string): string {
  return `${prefix}/objects/${sha256.slice(0, 2)}/${sha256}`
}

function ensureReference(ref: ImageAttachmentRef): string {
  const match = ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  return match[1]
}

/**
 * Run the full admission policy for one image without touching storage.
 * @param input - encoded bytes and declared metadata.
 * @param limits - resolved admission policy.
 * @param normalization - resolved stored-image normalization policy.
 * @returns completion after the encoded raster has been fully decoded.
 */
export async function validateImageObject(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  normalization: NormalizationPolicy,
): Promise<void> {
  await validateImageFile(input, limits, normalization)
}

/**
 * Admit and durably publish one image under its content address.
 *
 * The upload is unconditional, and content addressing is what makes that safe:
 * the key is the digest of the bytes being written, so an upload that finds
 * the key taken writes exactly what is already there, and the reference this
 * returns describes bytes this call itself wrote. Two writers of the same
 * image converge on one object; only the upload repeats. Publication needs no
 * counterpart to the local backend's directory syncing — once the upload
 * returns, every later reader observes the object.
 *
 * @param client - object-store port.
 * @param prefix - configured key prefix.
 * @param input - encoded bytes and declared metadata.
 * @param limits - resolved admission policy.
 * @param normalization - resolved stored-image normalization policy.
 * @param signal - optional cancellation for upload work.
 * @returns the durable content-addressed reference.
 */
export async function saveImageObject(
  client: ObjectClient,
  prefix: string,
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  normalization: NormalizationPolicy,
  signal?: AbortSignal,
): Promise<ImageAttachmentRef> {
  // Admission, normalization, naming, and the content address all come from
  // the shared helper, so an image admitted here is exactly the image the
  // in-box backend would admit and store. What is left is the commit.
  const prepared = await prepareImageFile(input, limits, normalization)
  const sha256 = String(prepared.ref.attachmentId).slice('sha256:'.length)
  const checksum = base64Digest(sha256)
  const key = objectKey(prefix, sha256)
  try {
    await client.put({
      key,
      data: prepared.data,
      mediaType: prepared.ref.mediaType,
      checksumSha256: checksum,
      metadata: {
        width: String(prepared.ref.width),
        height: String(prepared.ref.height),
      },
    }, signal)
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unable to persist image attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
  return prepared.ref
}

/**
 * Read and verify one content-addressed image.
 * @param client - object-store port.
 * @param prefix - configured key prefix.
 * @param ref - reference recorded in the session log.
 * @param signal - optional cancellation for transfer and verification work.
 * @returns verified bytes and reference.
 * @throws the signal reason when aborted, or an AttachmentError when verification fails.
 */
export async function readImageObject(
  client: ObjectClient,
  prefix: string,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredImageAttachment> {
  signal?.throwIfAborted()
  const sha256 = ensureReference(ref)
  let data: Uint8Array | undefined
  try {
    data = await client.get(objectKey(prefix, sha256), {
      ...(signal !== undefined ? { signal } : {}),
      maxBytes: ref.bytes,
    })
  } catch (error) {
    signal?.throwIfAborted()
    throw new AttachmentError('Unable to read image attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
  }
  signal?.throwIfAborted()
  if (data === undefined) throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
  if (digest(data) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  // The digest proves these are the exact bytes admission fully decoded, so
  // the read path only re-derives the header fields (no raster decode, no
  // per-request pixel amplification on history replay).
  const metadata = await probeImage(data)
  signal?.throwIfAborted()
  if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
    || metadata.width !== ref.width || metadata.height !== ref.height) {
    throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { ref, data }
}

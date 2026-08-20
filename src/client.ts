/**
 * The object-store port the attachment logic runs on, and its S3
 * implementation.
 *
 * The port exists so the store logic in `store.ts` stays free of an SDK type:
 * it needs exactly three write-once operations, and every rule it enforces
 * (content addressing, dedup verification, bounded reads) is expressible in
 * them. The S3 implementation owns bucket addressing, encryption, checksum
 * transport, and error classification.
 *
 * @module @guaguasong/dsh-attachment-s3/client
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Static credentials resolved per request from credential references. */
export interface ResolvedS3Credentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

/**
 * Per-request credential resolution. Called by the SDK's credential chain, so
 * a rotated secret reaches the next request without a plugin restart; a
 * deployment that leaves it undefined uses the SDK's own chain (environment,
 * shared config, container/instance roles).
 */
export type S3CredentialResolver = () => Promise<ResolvedS3Credentials>

/** Addressing inputs the S3 client needs. */
export interface S3ObjectClientOptions {
  bucket: string
  region?: string
  endpoint?: string
  /** Path-style addressing, required by most S3-compatible servers. */
  forcePathStyle?: boolean
  credentials?: S3CredentialResolver
}

/** What a stored object's metadata says about its bytes. */
export interface ObjectHead {
  /** Stored object length in bytes. */
  bytes: number
  /** Base64 SHA-256 the store recorded at upload, absent when the object predates checksum storage. */
  checksumSha256?: string
}

/** One write-once upload request. */
export interface PutObjectInput {
  key: string
  data: Uint8Array
  mediaType: ImageMediaType
  /** Base64-encoded raw SHA-256 digest, verified by the server against the received bytes. */
  checksumSha256: string
  /** Non-authoritative object metadata kept for bucket-side inspection. */
  metadata: Readonly<Record<string, string>>
}

/** Whether an upload created the object or found the same key already present. */
export type PutOutcome = 'stored' | 'exists'

/** Options for one bounded object read. */
export interface GetObjectOptions {
  signal?: AbortSignal
  /**
   * Refuse to buffer more than this many bytes. The caller knows the exact
   * expected length from the durable reference, so a longer stored object is
   * a corrupt object and must never be materialized in full.
   */
  maxBytes: number
}

/**
 * Write-once object storage. Implementations report a missing object as
 * `undefined` rather than by throwing; every other failure throws.
 */
export interface ObjectClient {
  /**
   * Read one object's metadata.
   * @param key - full object key.
   * @param signal - optional cancellation.
   * @returns the stored metadata, or `undefined` when the key is absent.
   */
  head(key: string, signal?: AbortSignal): Promise<ObjectHead | undefined>

  /**
   * Upload one object, never overwriting an existing key.
   * @param input - key, bytes, and integrity metadata.
   * @param signal - optional cancellation.
   * @returns `stored` when this call created the object, `exists` when the key was already taken.
   */
  put(input: PutObjectInput, signal?: AbortSignal): Promise<PutOutcome>

  /**
   * Read one object's bytes, bounded by `maxBytes`.
   * @param key - full object key.
   * @param options - cancellation and the caller's byte bound.
   * @returns the stored bytes, or `undefined` when the key is absent.
   */
  get(key: string, options: GetObjectOptions): Promise<Uint8Array | undefined>

  /** Release transport resources. Idempotent. */
  close(): void
}

/** What an SDK failure says about itself; a thrown non-object says nothing. */
function errorFacts(error: unknown): { name: string | undefined; status: number | undefined } {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null | undefined
  return { name: candidate?.name, status: candidate?.$metadata?.httpStatusCode }
}

/** Whether a failure means "this key is not there". */
function isNotFound(error: unknown): boolean {
  const { name, status } = errorFacts(error)
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404
}

/** Whether a conditional write lost: the key already exists. */
function isPreconditionFailed(error: unknown): boolean {
  const { name, status } = errorFacts(error)
  return name === 'PreconditionFailed' || status === 412
}

/**
 * Per-request SDK options. Written as a spread so an omitted signal stays
 * omitted: the SDK's option type does not accept an explicit `undefined`.
 * @param signal - optional cancellation.
 * @returns the options to pass alongside one command.
 */
function requestOptions(signal: AbortSignal | undefined): { abortSignal?: AbortSignal } {
  return signal !== undefined ? { abortSignal: signal } : {}
}

/**
 * Build the S3-backed object client.
 * @param options - bucket addressing and object policy.
 * @returns a client owning one `S3Client`; the caller closes it.
 */
export function createS3ObjectClient(options: S3ObjectClientOptions): ObjectClient {
  const resolveCredentials = options.credentials
  const config: S3ClientConfig = {
    ...(options.region !== undefined ? { region: options.region } : {}),
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
    // The SDK caches what this returns for the credential's lifetime and
    // re-invokes it on expiry, so a reference resolved here follows the
    // seam's per-operation read rule closely enough for request signing
    // while never holding a value in plugin state.
    ...(resolveCredentials !== undefined ? { credentials: resolveCredentials } : {}),
  }
  const client = new S3Client(config)
  const bucket = options.bucket

  return {
    async head(key, signal) {
      try {
        const response = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }),
          requestOptions(signal),
        )
        return {
          bytes: response.ContentLength ?? 0,
          ...(response.ChecksumSHA256 !== undefined ? { checksumSha256: response.ChecksumSHA256 } : {}),
        }
      } catch (error) {
        if (isNotFound(error)) return undefined
        throw error
      }
    },

    async put(input, signal) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: input.key,
            Body: input.data,
            ContentLength: input.data.byteLength,
            ContentType: input.mediaType,
            ChecksumSHA256: input.checksumSha256,
            Metadata: { ...input.metadata },
            // Content-addressed keys are immutable, so a taken key is never
            // ours to replace: the conditional write turns a concurrent
            // upload of the same bytes into a cheap, explicit outcome.
            IfNoneMatch: '*',
          }),
          requestOptions(signal),
        )
        return 'stored'
      } catch (error) {
        if (isPreconditionFailed(error)) return 'exists'
        throw error
      }
    },

    async get(key, { signal, maxBytes }) {
      let response
      try {
        response = await client.send(
          // An inclusive range of maxBytes reads one byte past the expected
          // length: a longer stored object comes back longer than the
          // reference claims and is rejected as corrupt instead of being
          // truncated into a false match.
          new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${maxBytes}` }),
          requestOptions(signal),
        )
      } catch (error) {
        if (isNotFound(error)) return undefined
        throw error
      }
      /* v8 ignore next -- GetObject types Body as optional; a response that reached this point always carries the stream. */
      if (response.Body === undefined) return undefined
      return await response.Body.transformToByteArray()
    },

    close() {
      client.destroy()
    },
  }
}

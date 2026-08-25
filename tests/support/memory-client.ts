/**
 * In-memory object store standing in for a bucket: stored bytes and
 * checksums, ranged reads, and injectable transport faults.
 *
 * @module tests/support/memory-client
 */

import type { GetObjectOptions, ObjectClient, PutObjectInput } from '../../src/client.ts'

/** One object as a bucket would hold it. */
export interface MemoryObject {
  data: Uint8Array
  mediaType: string
  checksumSha256?: string
  metadata: Record<string, string>
}

/** Behavior knobs for one memory client. */
export interface MemoryClientOptions {
  /** Whether uploads record the caller's checksum, as a bucket with additional checksums enabled does. */
  storeChecksums?: boolean
  /** Transport failure raised by the next matching call, then cleared. */
  faults?: { put?: Error; get?: Error }
}

/** In-memory {@link ObjectClient}. */
export class MemoryObjectClient implements ObjectClient {
  /** Every stored object, keyed exactly as the store addressed it. */
  readonly objects = new Map<string, MemoryObject>()
  /** Keys the store uploaded, in call order. */
  readonly puts: string[] = []
  /** Keys the store read, in call order. */
  readonly gets: string[] = []
  /** Whether `close` has run. */
  closed = false

  readonly #options: MemoryClientOptions

  constructor(options: MemoryClientOptions = {}) {
    this.#options = { storeChecksums: true, ...options }
  }

  /** Replace one stored object's bytes the way a bucket-side substitution would. */
  tamper(key: string, data: Uint8Array): void {
    const existing = this.objects.get(key)
    if (existing === undefined) throw new Error(`no stored object at ${key}`)
    this.objects.set(key, { ...existing, data })
  }

  #fault(kind: 'put' | 'get'): void {
    const fault = this.#options.faults?.[kind]
    if (fault === undefined) return
    delete this.#options.faults?.[kind]
    throw fault
  }

  async put(input: PutObjectInput, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.puts.push(input.key)
    this.#fault('put')
    this.objects.set(input.key, {
      data: input.data,
      mediaType: input.mediaType,
      ...(this.#options.storeChecksums === true ? { checksumSha256: input.checksumSha256 } : {}),
      metadata: { ...input.metadata },
    })
  }

  async get(key: string, options: GetObjectOptions): Promise<Uint8Array | undefined> {
    options.signal?.throwIfAborted()
    this.gets.push(key)
    this.#fault('get')
    const object = this.objects.get(key)
    if (object === undefined) return undefined
    return object.data.subarray(0, options.maxBytes + 1)
  }

  close(): void {
    this.closed = true
  }
}

/** One-pixel PNG shared by every spec that needs admissible bytes. */
export const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))

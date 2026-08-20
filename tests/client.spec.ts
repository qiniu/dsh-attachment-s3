import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createS3ObjectClient } from '../src/client.ts'
import type { ObjectClient } from '../src/client.ts'
import { BUCKET, startFakeS3, type FakeS3, type FakeS3Options } from './support/fake-s3.ts'
import { PNG } from './support/memory-client.ts'

const CHECKSUM = createHash('sha256').update(PNG).digest('base64')

const services: FakeS3[] = []
const clients: ObjectClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const running of services.splice(0)) await running.close()
})

/**
 * Start one fake service registered for teardown.
 * @param options - service behavior under test.
 * @returns the running service.
 */
async function service(options: FakeS3Options = {}): Promise<FakeS3> {
  const running = await startFakeS3(options)
  services.push(running)
  return running
}

/**
 * Build a client against one fake service.
 * @param endpoint - the service endpoint.
 * @param overrides - object-policy fields under test.
 * @returns the client, registered for teardown.
 */
function client(endpoint: string, overrides: Partial<Parameters<typeof createS3ObjectClient>[0]> = {}): ObjectClient {
  const created = createS3ObjectClient({
    bucket: BUCKET,
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: async () => ({ accessKeyId: 'test-key', secretAccessKey: 'test-secret' }),
    ...overrides,
  })
  clients.push(created)
  return created
}

describe('S3 object client', () => {
  it('uploads write-once objects carrying their content type, checksum, and metadata', async () => {
    const { endpoint, objects, seen } = await service()
    const s3 = client(endpoint)

    const outcome = await s3.put({
      key: 'attachments/v1/objects/ab/abc',
      data: PNG,
      mediaType: 'image/png',
      checksumSha256: CHECKSUM,
      metadata: { width: '1', height: '1' },
    })

    expect(outcome).toBe('stored')
    expect(objects.get('attachments/v1/objects/ab/abc')).toEqual(PNG)
    const request = seen[0]
    expect(request?.method).toBe('PUT')
    expect(request?.url.split('?')[0]).toBe('/dsh-attachments/attachments/v1/objects/ab/abc')
    expect(request?.headers['if-none-match']).toBe('*')
    expect(request?.headers['content-type']).toBe('image/png')
    expect(request?.headers['x-amz-checksum-sha256']).toBe(CHECKSUM)
    expect(request?.headers['x-amz-meta-width']).toBe('1')
  })

  it('reports a key another writer already took instead of overwriting it', async () => {
    const { endpoint, objects } = await service()
    const s3 = client(endpoint)
    const input = { key: 'k', data: PNG, mediaType: 'image/png' as const, checksumSha256: CHECKSUM, metadata: {} }

    await expect(s3.put(input)).resolves.toBe('stored')
    await expect(s3.put({ ...input, data: Uint8Array.of(1) })).resolves.toBe('exists')
    expect(objects.get('k')).toEqual(PNG)
  })

  it('reads metadata and bytes, bounding the transfer with a range request', async () => {
    const { endpoint, seen } = await service()
    const s3 = client(endpoint)
    await s3.put({ key: 'k', data: PNG, mediaType: 'image/png', checksumSha256: CHECKSUM, metadata: {} })

    await expect(s3.head('k')).resolves.toEqual({ bytes: PNG.byteLength, checksumSha256: CHECKSUM })
    await expect(s3.get('k', { maxBytes: PNG.byteLength })).resolves.toEqual(PNG)
    expect(seen.at(-1)?.headers.range).toBe(`bytes=0-${PNG.byteLength}`)
  })

  it('reports metadata without a checksum when the service stores none', async () => {
    const { endpoint } = await service({ checksums: false })
    const s3 = client(endpoint)
    await s3.put({ key: 'k', data: PNG, mediaType: 'image/png', checksumSha256: CHECKSUM, metadata: {} })

    await expect(s3.head('k')).resolves.toEqual({ bytes: PNG.byteLength })
  })

  it('reports an absent key as undefined from both read paths', async () => {
    const { endpoint } = await service()
    const s3 = client(endpoint)

    await expect(s3.head('missing')).resolves.toBeUndefined()
    await expect(s3.get('missing', { maxBytes: 10 })).resolves.toBeUndefined()
  })

  it('propagates a transport failure rather than reporting an absent object', async () => {
    const { endpoint } = await service()
    const s3 = client(endpoint.replace(/:\d+$/, ':1'))

    await expect(s3.get('k', { maxBytes: 10 })).rejects.toThrow()
  })

  it('propagates a metadata-read failure instead of reporting the key as absent', async () => {
    const { endpoint } = await service()
    const s3 = client(endpoint.replace(/:\d+$/, ':1'))

    await expect(s3.head('k')).rejects.toThrow()
  })

  it('propagates an upload failure instead of reporting the key as taken', async () => {
    const { endpoint } = await service()
    const s3 = client(endpoint.replace(/:\d+$/, ':1'))

    await expect(s3.put({ key: 'k', data: PNG, mediaType: 'image/png', checksumSha256: CHECKSUM, metadata: {} }))
      .rejects.toThrow()
  })

  it('surfaces cancellation to the caller', async () => {
    const { endpoint } = await service()
    const s3 = client(endpoint)
    const controller = new AbortController()
    controller.abort()

    await expect(s3.get('k', { maxBytes: 10, signal: controller.signal })).rejects.toThrow()
  })
})

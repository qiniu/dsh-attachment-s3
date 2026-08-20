import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/index.ts'
import S3AttachmentStore, {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  DEFAULT_PREFIX,
} from '../src/index.ts'
import { BUCKET as FAKE_BUCKET, startFakeS3, type FakeS3 } from './support/fake-s3.ts'
import { PNG } from './support/memory-client.ts'

const BUCKET = { bucket: FAKE_BUCKET, region: 'us-east-1' }

const services: FakeS3[] = []
const restore: (() => void)[] = []

afterEach(async () => {
  for (const undo of restore.splice(0)) undo()
  for (const running of services.splice(0)) await running.close()
})

/**
 * Start one fake service registered for teardown.
 * @returns the running service.
 */
async function service(): Promise<FakeS3> {
  const running = await startFakeS3()
  services.push(running)
  return running
}

/**
 * Set one environment variable for the duration of a spec.
 * @param name - variable name.
 * @param value - value to expose.
 */
function withEnv(name: string, value: string): void {
  const previous = process.env[name]
  process.env[name] = value
  restore.push(() => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  })
}

/**
 * Build a store pointed at one fake service.
 * @param endpoint - the service endpoint.
 * @param config - configuration under test.
 * @returns the store.
 */
function storeAt(endpoint: string, config: Partial<Config> = {}): S3AttachmentStore {
  return new S3AttachmentStore(new Context(), { ...BUCKET, endpoint, forcePathStyle: true, ...config })
}

describe('S3 attachment service', () => {
  it('resolves every omitted admission limit and the key prefix explicitly', () => {
    const service = new S3AttachmentStore(new Context(), { ...BUCKET })
    expect(DEFAULT_MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024)
    expect(service.bucket).toBe('dsh-attachments')
    expect(service.prefix).toBe(DEFAULT_PREFIX)
    expect(service.imageLimits).toEqual({
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    })
  })

  it('accepts a configured prefix with or without its trailing slash', () => {
    expect(new S3AttachmentStore(new Context(), { ...BUCKET, prefix: 'team/shots/' }).prefix).toBe('team/shots')
    expect(new S3AttachmentStore(new Context(), { ...BUCKET, prefix: 'team/shots' }).prefix).toBe('team/shots')
  })

  it('refuses a prefix that cannot address objects', () => {
    for (const prefix of ['', '/absolute', 'up/../out', './here', 'trailing//empty']) {
      expect(() => new S3AttachmentStore(new Context(), { ...BUCKET, prefix }))
        .toThrow(/must be a relative key prefix/)
    }
  })

  it('refuses credential references that are incomplete or not environment-variable names', () => {
    const store = (config: Partial<Config>) => () => new S3AttachmentStore(new Context(), { ...BUCKET, ...config })

    expect(store({ accessKeyIdRef: 'AWS_ACCESS_KEY_ID' })).toThrow(/both accessKeyIdRef and secretAccessKeyRef/)
    expect(store({ secretAccessKeyRef: 'AWS_SECRET_ACCESS_KEY' })).toThrow(/both accessKeyIdRef and secretAccessKeyRef/)
    expect(store({ sessionTokenRef: 'AWS_SESSION_TOKEN' })).toThrow(/sessionTokenRef needs/)
    expect(store({ accessKeyIdRef: 'AWS_ACCESS_KEY_ID', secretAccessKeyRef: 'aws secret' }))
      .toThrow(/secretAccessKeyRef must be the NAME of an environment variable/)
    expect(store({ accessKeyIdRef: 'AWS_ACCESS_KEY_ID', secretAccessKeyRef: 'AWS_SECRET_ACCESS_KEY', sessionTokenRef: '2BAD' }))
      .toThrow(/sessionTokenRef must be the NAME of an environment variable/)
    expect(store({ accessKeyIdRef: 'AWS_ACCESS_KEY_ID', secretAccessKeyRef: 'AWS_SECRET_ACCESS_KEY', sessionTokenRef: 'AWS_SESSION_TOKEN' }))
      .not.toThrow()
  })

  it('never repeats a rejected credential value, since it is usually the secret itself', () => {
    const secret = 'A-secret-pasted-where-a-variable-name-belongs'
    let reported = ''
    try {
      new S3AttachmentStore(new Context(), { ...BUCKET, accessKeyIdRef: secret, secretAccessKeyRef: secret })
    } catch (error) {
      reported = `${String(error)}${String((error as Error).stack)}`
    }
    expect(reported).toContain('accessKeyIdRef must be the NAME of an environment variable')
    expect(reported).not.toContain(secret)
  })

  it('validates configuration before the plugin loads', () => {
    // The composition file's rows arrive untyped, which is exactly what this
    // schema is there to reject.
    const validate = S3AttachmentStore.Config as unknown as (value: unknown) => Config

    expect(() => validate({})).toThrow()
    expect(validate({ bucket: 'dsh-attachments' })).toMatchObject({
      bucket: 'dsh-attachments',
      prefix: DEFAULT_PREFIX,
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    })
    expect(() => validate({ bucket: 'dsh-attachments', maxImageBytes: 0 })).toThrow()
    expect(() => validate({ bucket: 'dsh-attachments', prefix: 42 })).toThrow()
  })

  it('registers on the attachment seam and releases the client on dispose', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(S3AttachmentStore, { ...BUCKET })
    expect(ctx.get('attachments')).toBeInstanceOf(S3AttachmentStore)

    await fiber.dispose()
    expect(ctx.get('attachments')).toBeUndefined()
  })

  it('enforces the seam batch policy before any request leaves the process', async () => {
    const image = { data: PNG, mediaType: 'image/png' } as const
    const service = new S3AttachmentStore(new Context(), { ...BUCKET, maxImagesPerMessage: 1 })
    await expect(service.saveImages([image, image])).rejects.toMatchObject({ code: 'TOO_MANY_IMAGES' })

    const capped = new S3AttachmentStore(new Context(), { ...BUCKET, maxMessageImageBytes: 8 })
    await expect(capped.saveImages([image])).rejects.toMatchObject({ code: 'IMAGES_TOO_LARGE' })

    await expect(service.saveImages([{ data: PNG, mediaType: 'image/avif' as 'image/png' }]))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE_TYPE' })
  })

  it('saves, deduplicates, and reads back through the mounted service', async () => {
    const { endpoint, objects } = await service()
    withEnv('DSH_S3_TEST_KEY_ID', 'test-key')
    withEnv('DSH_S3_TEST_SECRET', 'test-secret')
    const ctx = new Context()
    // Through `ctx.attachments`, not the constructed instance: consumers reach
    // the service as a Cordis proxy, and a method that touched an ECMAScript
    // private field would throw only on this path.
    await ctx.plugin(S3AttachmentStore, {
      ...BUCKET,
      endpoint,
      forcePathStyle: true,
      accessKeyIdRef: 'DSH_S3_TEST_KEY_ID',
      secretAccessKeyRef: 'DSH_S3_TEST_SECRET',
    })

    const [ref] = await ctx.attachments.saveImages([{ data: PNG, mediaType: 'image/png', name: 'shot.png' }])
    expect(ref).toMatchObject({ mediaType: 'image/png', bytes: PNG.byteLength, width: 1, height: 1, name: 'shot.png' })
    expect(objects.size).toBe(1)
    expect([...objects.keys()][0]).toMatch(/^attachments\/v1\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/)

    const again = await ctx.attachments.saveImage({ data: PNG, mediaType: 'image/png' })
    expect(again.attachmentId).toBe(ref!.attachmentId)
    expect(objects.size).toBe(1)

    await expect(ctx.attachments.readImage(ref!)).resolves.toEqual({ ref, data: PNG })
    await expect(ctx.attachments.validateImage({ data: PNG, mediaType: 'image/png' })).resolves.toBeUndefined()
  })

  it('resolves credential references through the credential seam when one is loaded', async () => {
    const { endpoint } = await service()
    const ctx = new Context()
    const asked: string[] = []
    ctx.provide('credentials', {
      resolve: async (ref: string) => {
        asked.push(ref)
        return { value: ref === 'DSH_S3_TEST_KEY_ID' ? 'test-key' : 'test-secret', source: 'test' }
      },
    })
    const store = new S3AttachmentStore(ctx, {
      ...BUCKET,
      endpoint,
      forcePathStyle: true,
      accessKeyIdRef: 'DSH_S3_TEST_KEY_ID',
      secretAccessKeyRef: 'DSH_S3_TEST_SECRET',
    })

    await store.saveImage({ data: PNG, mediaType: 'image/png' })
    expect(asked).toEqual(['DSH_S3_TEST_KEY_ID', 'DSH_S3_TEST_SECRET'])
  })

  it('fails the upload when a credential reference resolves to nothing', async () => {
    const { endpoint, objects } = await service()
    const store = storeAt(endpoint, { accessKeyIdRef: 'DSH_S3_ABSENT_KEY_ID', secretAccessKeyRef: 'DSH_S3_ABSENT_SECRET' })

    await expect(store.saveImage({ data: PNG, mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
    expect(objects.size).toBe(0)
  })

  it('keys objects under the configured prefix and signs with a session token', async () => {
    const { endpoint, seen } = await service()
    withEnv('DSH_S3_TEST_KEY_ID', 'test-key')
    withEnv('DSH_S3_TEST_SECRET', 'test-secret')
    withEnv('DSH_S3_TEST_TOKEN', 'test-token')
    const store = storeAt(endpoint, {
      prefix: 'team/shots',
      accessKeyIdRef: 'DSH_S3_TEST_KEY_ID',
      secretAccessKeyRef: 'DSH_S3_TEST_SECRET',
      sessionTokenRef: 'DSH_S3_TEST_TOKEN',
    })

    await store.saveImage({ data: PNG, mediaType: 'image/png' })

    expect(seen[0]?.url).toContain('/team/shots/objects/')
    expect(seen[0]?.headers['x-amz-security-token']).toBe('test-token')
  })

  it('validates images without contacting the bucket', async () => {
    const service = new S3AttachmentStore(new Context(), { ...BUCKET })
    await expect(service.validateImage({ data: PNG, mediaType: 'image/png' })).resolves.toBeUndefined()
    await expect(service.validateImage({ data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })
})

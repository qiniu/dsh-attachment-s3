/**
 * S3 attachment backend: content-addressed immutable objects in one bucket,
 * registered on the harness attachment seam (`ctx.attachments`).
 *
 * @module @qiniu/dsh-attachment-s3
 */

import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  ImageRequestPolicy,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
  readRequestImageFile,
} from '@deepseek-ai/dsh-attachment-local'
import type { NormalizationPolicy } from '@deepseek-ai/dsh-attachment-local'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createS3ObjectClient } from './client.ts'
import type { ObjectClient, ResolvedS3Credentials, S3ObjectClientOptions } from './client.ts'
import { readImageObject, saveImageObject, validateImageObject } from './store.ts'

/** Default key prefix; the version segment fences a future incompatible layout off from stored objects. */
export const DEFAULT_PREFIX = 'attachments/v1'

// Admission and normalization defaults are re-exported from the in-box local
// backend rather than restated, so the two backends cannot drift apart on
// which images they accept or how they normalize what they store.
export {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
} from '@deepseek-ai/dsh-attachment-local'

const MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/** Same POSIX shell identifier the harness credential seam accepts as a reference. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** A key prefix addresses objects; it must not be absolute, empty, or able to walk out of itself. */
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-]*(\/[A-Za-z0-9][A-Za-z0-9._\-]*)*$/

/** S3 attachment backend configuration. */
export interface Config {
  /** Bucket holding every attachment object. */
  bucket: string
  /** Bucket region; omitted follows the AWS SDK's own region resolution. */
  region?: string
  /** Endpoint of an S3-compatible service; omitted addresses AWS S3. */
  endpoint?: string
  /** Path-style addressing, required by most S3-compatible services. */
  forcePathStyle?: boolean
  /** Key prefix owning this deployment's attachment objects. */
  prefix?: string
  /**
   * Reference to the access key id used for request signing: an
   * environment-variable name, never a value, so a composition file stays safe
   * to commit and to render in a configuration surface. Omitting both key
   * references uses the AWS SDK's own chain (environment, shared config,
   * container or instance roles), which is what a deployment holding an
   * instance role wants.
   */
  accessKeyIdRef?: string
  /** Reference to the secret access key; required with, and only with, {@link Config.accessKeyIdRef}. */
  secretAccessKeyRef?: string
  /** Reference to the session token of temporary credentials. */
  sessionTokenRef?: string
  /** Maximum encoded bytes accepted for one image. */
  maxImageBytes?: number
  /** Maximum image count accepted in one submitted message. */
  maxImagesPerMessage?: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. */
  maxMessageImageBytes?: number
  /** Maximum intrinsic width multiplied by height accepted for one image. */
  maxImagePixels?: number
  /** Maximum intrinsic width and maximum intrinsic height, applied per side, for one image. */
  maxImageDimension?: number
  /** Long-edge target of the stored normalized image; a larger admitted image is downscaled to it. */
  normalizedImageMaxDimension?: number
  /** Byte budget of the stored normalized image. */
  normalizedImageMaxBytes?: number
  /**
   * Directory holding derived request images. They are recomputed from the
   * stored object whenever they are missing, so this is a cache and not
   * storage: it stays local rather than occupying the bucket. Omitted resolves
   * below the Harness home.
   */
  variantCacheDir?: string
}

/**
 * The part of the harness credential seam (`ctx.credentials`) this backend
 * reads. Declared structurally rather than imported so an S3 deployment needs
 * no credential provider loaded at all: the seam is used when present, and
 * `process.env` answers the same reference when it is not.
 */
interface CredentialReader {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/**
 * Resolve one credential reference at request time.
 * @param ctx - the plugin context, consulted for a loaded credential provider on every call.
 * @param ref - environment-variable name naming the secret.
 * @returns the current value.
 * @throws when no source supplies a non-empty value.
 */
async function resolveRef(ctx: Context, ref: string): Promise<string> {
  // Read the service per call rather than capturing it: the provider may be
  // loaded, replaced, or unloaded while this backend keeps running.
  const provider = ctx.reflect.get('credentials') as CredentialReader | undefined
  const resolved = await provider?.resolve(ref)
  if (resolved !== undefined && resolved.value !== '') return resolved.value
  const fallback = process.env[ref]
  if (fallback !== undefined && fallback !== '') return fallback
  throw new Error(`S3 credential reference ${ref} is not configured.`)
}

/**
 * Content-addressed S3 attachment store.
 *
 * Objects are immutable and named by the SHA-256 of their bytes, so identical
 * images from any number of sessions or processes converge on one object and a
 * write never has to overwrite. Reads verify the digest before returning, so a
 * bucket-side substitution surfaces as `ATTACHMENT_CORRUPT` instead of
 * reaching a model request.
 */
export class S3AttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    bucket: z.string().required(),
    region: z.string(),
    endpoint: z.string(),
    forcePathStyle: z.boolean(),
    prefix: z.string().default(DEFAULT_PREFIX),
    accessKeyIdRef: z.string(),
    secretAccessKeyRef: z.string(),
    sessionTokenRef: z.string(),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
    maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
    maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
    maxImageDimension: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_DIMENSION),
    normalizedImageMaxDimension: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION),
    normalizedImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_BYTES),
    variantCacheDir: z.string(),
  })

  /** Bucket every object of this store lives in. */
  readonly bucket: string
  /** Key prefix owning this deployment's objects, without a trailing slash. */
  readonly prefix: string
  readonly imageLimits: ImageAttachmentLimits
  /** Normalization applied to what this store keeps, shared with the in-box backend's policy shape. */
  readonly normalizationPolicy: Readonly<NormalizationPolicy>
  /** Absolute directory holding derived request images. */
  readonly variantCacheDir: string

  /**
   * The object-store port this service runs on. A plain private property, not
   * an ECMAScript private field: Cordis hands consumers a proxy of the service
   * instance, and `#field` access from a method whose `this` is that proxy
   * throws.
   */
  private readonly client: ObjectClient

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.bucket = config.bucket
    this.prefix = normalizePrefix(config.prefix ?? DEFAULT_PREFIX)
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: Object.freeze([...MEDIA_TYPES]),
    })
    this.normalizationPolicy = Object.freeze({
      maxDimension: config.normalizedImageMaxDimension ?? DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
      maxBytes: config.normalizedImageMaxBytes ?? DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
    })
    this.variantCacheDir = config.variantCacheDir === undefined
      ? resolve(join(resolveDshHome(), 'attachments', 's3-request-images'))
      : resolve(config.variantCacheDir)
    this.client = createS3ObjectClient(resolveClientOptions(ctx, config))
    ctx.effect(() => () => {
      this.client.close()
    }, 'attachment-s3.client')
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await validateImageObject(input, this.imageLimits, this.normalizationPolicy)
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return saveImageObject(this.client, this.prefix, input, this.imageLimits, this.normalizationPolicy)
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return readImageObject(this.client, this.prefix, ref, signal)
  }

  /**
   * Derive the version of one image that a model request carries, bounded by
   * the caller's policy.
   *
   * The bytes come from the bucket; the encoder decisions — target dimensions,
   * format and quality search, alpha and colour handling, and the variant id
   * consumers cache by — are the in-box backend's, so both backends put the
   * same picture in front of a model. Derived versions are cached under
   * {@link S3AttachmentStore.variantCacheDir}: they are reproducible from the
   * stored object, so they belong beside the process that needs them rather
   * than in the bucket.
   * @param ref - durable reference from the session log.
   * @param policy - the request's pixel and byte budget.
   * @param signal - optional cancellation for transfer and encoding work.
   * @returns the request version and the variant id identifying it.
   */
  override async readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    const stored = await this.readImage(ref, signal)
    return readRequestImageFile(this.variantCacheDir, stored, policy, signal)
  }
}

/**
 * Reject a key prefix that cannot address objects, and strip the trailing
 * slash so key construction has one form.
 * @param prefix - configured prefix.
 * @returns the prefix without a trailing slash.
 * @throws TypeError when the prefix is empty, absolute, or contains a traversal segment.
 */
function normalizePrefix(prefix: string): string {
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  if (!PREFIX_PATTERN.test(trimmed)) {
    throw new TypeError(`attachment-s3 prefix "${prefix}" must be a relative key prefix such as "attachments/v1".`)
  }
  return trimmed
}

/**
 * Project validated configuration onto the object client's inputs, checking
 * credential references at load time so an unusable reference fails before the
 * first upload rather than during one.
 * @param ctx - plugin context used to read the credential seam per request.
 * @param config - validated plugin configuration.
 * @returns the client options, including the per-request credential resolver.
 * @throws TypeError when the credential references are incomplete or malformed.
 */
function resolveClientOptions(ctx: Context, config: Config): S3ObjectClientOptions {
  const refs = resolveCredentialRefs(config)
  return {
    bucket: config.bucket,
    ...(config.region !== undefined ? { region: config.region } : {}),
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
    ...(refs !== undefined
      ? {
          credentials: async (): Promise<ResolvedS3Credentials> => {
            const [accessKeyId, secretAccessKey, sessionToken] = await Promise.all([
              resolveRef(ctx, refs.accessKeyId),
              resolveRef(ctx, refs.secretAccessKey),
              refs.sessionToken !== undefined ? resolveRef(ctx, refs.sessionToken) : Promise.resolve(undefined),
            ])
            return {
              accessKeyId,
              secretAccessKey,
              ...(sessionToken !== undefined ? { sessionToken } : {}),
            }
          },
        }
      : {}),
  }
}

/**
 * Read the credential references as one unit: either the pair naming static
 * credentials, or nothing at all. A half-declared pair is a misconfiguration
 * that would otherwise degrade silently into the SDK's ambient chain and sign
 * requests as an identity the composition file never named.
 * @param config - validated plugin configuration.
 * @returns the reference triple, or `undefined` when the deployment signs with the SDK's own chain.
 * @throws TypeError when the pair is incomplete or a reference is not an environment-variable name.
 */
function resolveCredentialRefs(config: Config): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined {
  const { accessKeyIdRef, secretAccessKeyRef, sessionTokenRef } = config
  if (accessKeyIdRef === undefined && secretAccessKeyRef === undefined) {
    if (sessionTokenRef !== undefined) {
      throw new TypeError('attachment-s3 sessionTokenRef needs accessKeyIdRef and secretAccessKeyRef.')
    }
    return undefined
  }
  if (accessKeyIdRef === undefined || secretAccessKeyRef === undefined) {
    throw new TypeError('attachment-s3 needs both accessKeyIdRef and secretAccessKeyRef, or neither.')
  }
  const declared: readonly (readonly [string, string])[] = [
    ['accessKeyIdRef', accessKeyIdRef],
    ['secretAccessKeyRef', secretAccessKeyRef],
    ...(sessionTokenRef !== undefined ? [['sessionTokenRef', sessionTokenRef] as const] : []),
  ]
  for (const [field, ref] of declared) {
    if (CREDENTIAL_REF_PATTERN.test(ref)) continue
    // The rejected value is never echoed: the commonest way to land here is
    // pasting the secret itself into the field, and a diagnostic that repeated
    // it would copy that secret into stderr and every log that collects it.
    throw new TypeError(
      `attachment-s3 ${field} must be the NAME of an environment variable holding the credential`
      + ' (such as S3_ACCESS_KEY_ID), not the credential itself; the value given is not a valid'
      + ' variable name and is not repeated here.',
    )
  }
  return {
    accessKeyId: accessKeyIdRef,
    secretAccessKey: secretAccessKeyRef,
    ...(sessionTokenRef !== undefined ? { sessionToken: sessionTokenRef } : {}),
  }
}

export default S3AttachmentStore

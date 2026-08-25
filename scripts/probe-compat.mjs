/**
 * Probe one S3-compatible service for the behaviors this backend relies on.
 *
 * The store needs three things from a bucket: an upload that accepts a SHA-256
 * checksum header, ranged reads, and a distinguishable "no such key". Services
 * differ on the first, so run this before pointing a deployment at a new
 * provider.
 *
 * Usage:
 *   PROBE_ENDPOINT=https://s3.example.com \
 *   PROBE_REGION=us-east-1 \
 *   PROBE_BUCKET=<s3 bucket name> \
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *   node scripts/probe-compat.mjs
 *
 * Optional: PROBE_FORCE_PATH_STYLE=true, PROBE_PREFIX (default `dsh-probe`).
 * The probe writes two small objects under the prefix and deletes them.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

const endpoint = process.env.PROBE_ENDPOINT
const region = process.env.PROBE_REGION ?? 'us-east-1'
const bucket = process.env.PROBE_BUCKET
const forcePathStyle = process.env.PROBE_FORCE_PATH_STYLE === 'true'
const prefix = process.env.PROBE_PREFIX ?? 'dsh-probe'

if (bucket === undefined) {
  console.error('PROBE_BUCKET is required (the S3 bucket name, which on some providers differs from the console space name)')
  process.exit(2)
}

const client = new S3Client({
  region,
  ...(endpoint !== undefined ? { endpoint } : {}),
  ...(forcePathStyle ? { forcePathStyle } : {}),
})

const key = `${prefix}/${randomBytes(6).toString('hex')}`
const badKey = `${key}-badsum`
const body = randomBytes(64)
const checksum = createHash('sha256').update(body).digest('base64')
const results = []

/**
 * Run one probe step and record what happened.
 * @param name - short label printed in the report.
 * @param run - the step; returns a verdict line, or throws.
 * @returns the verdict object recorded for the report.
 */
async function step(name, run) {
  try {
    const detail = await run()
    const result = { name, ok: true, detail }
    results.push(result)
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`)
    return result
  } catch (error) {
    const code = error?.name ?? 'Error'
    const status = error?.$metadata?.httpStatusCode
    const detail = `${code}${status ? ` (HTTP ${status})` : ''}: ${String(error?.message ?? error).slice(0, 160)}`
    const result = { name, ok: false, detail }
    results.push(result)
    console.log(`  FAIL  ${name} — ${detail}`)
    return result
  }
}

console.log(`probing ${endpoint ?? 'AWS S3'} region=${region} bucket=${bucket} pathStyle=${forcePathStyle}\n`)

const sha256Put = await step('PutObject with x-amz-checksum-sha256', async () => {
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentLength: body.byteLength,
    ContentType: 'image/png', ChecksumSHA256: checksum, Metadata: { width: '1', height: '1' },
  }))
  return 'accepted'
})

if (!sha256Put.ok) {
  await step('PutObject with no checksum header at all', async () => {
    const bare = new S3Client({
      region,
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(forcePathStyle ? { forcePathStyle } : {}),
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
    try {
      await bare.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentLength: body.byteLength, ContentType: 'image/png',
      }))
      return 'accepted — the service needs checksums disabled'
    } finally {
      bare.destroy()
    }
  })
}

const checksumEnforced = await step('PutObject with a WRONG checksum is rejected', async () => {
  const wrong = createHash('sha256').update(randomBytes(32)).digest('base64')
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: badKey, Body: body, ContentLength: body.byteLength,
      ContentType: 'image/png', ChecksumSHA256: wrong,
    }))
    // The service stored bytes whose checksum it was told, and did not check.
    return 'NOT ENFORCED — the mismatching checksum was accepted'
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode
    if (status === 400 || /Checksum|BadDigest|InvalidRequest/i.test(String(error?.name))) {
      return `enforced (${error.name})`
    }
    throw error
  }
})
const checksumVerified = checksumEnforced.ok && checksumEnforced.detail.startsWith('enforced')

await step('Ranged GET returns exactly the requested bytes', async () => {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${body.byteLength}` }))
  const bytes = await response.Body.transformToByteArray()
  if (bytes.byteLength !== body.byteLength) throw new Error(`expected ${body.byteLength} bytes, got ${bytes.byteLength}`)
  return `${bytes.byteLength} bytes`
})

await step('GET of an absent key reports NoSuchKey/404', async () => {
  try {
    await client.send(new GetObjectCommand({ Bucket: bucket, Key: `${key}-absent` }))
    throw new Error('the read SUCCEEDED for a key that was never written')
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode
    if (error?.name === 'NoSuchKey' || status === 404) return `${error.name}`
    throw error
  }
})

await step('cleanup', async () => {
  for (const target of [key, badKey]) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: target })).catch(() => undefined)
  }
  return 'probe objects deleted'
})

client.destroy()

console.log('\nverdict')
if (!sha256Put.ok) {
  console.log('  This service rejects the SHA-256 checksum header. The backend cannot run against it')
  console.log('  until it gains a checksum-free mode — report the FAIL line above.')
} else if (!checksumVerified) {
  console.log('  The checksum header is accepted but NOT verified: transfer integrity rests on TLS and on')
  console.log('  the read path re-hashing every object before it returns.')
} else {
  console.log('  Checksums accepted and verified on upload.')
}
process.exit(results.some(result => !result.ok && result.name === 'cleanup') ? 1 : 0)

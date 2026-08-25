/**
 * A minimal S3-compatible service over loopback HTTP: path-style addressing,
 * PUT, ranged GET, and the error codes the client classifies. It
 * lets specs exercise the real SDK wiring — signing, headers, status mapping —
 * without a bucket or a network.
 *
 * @module tests/support/fake-s3
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One request the service saw, reduced to what the wiring must get right. */
export interface SeenRequest {
  method: string
  url: string
  headers: Record<string, string | undefined>
  body: Uint8Array
}

/** A running fake service. */
export interface FakeS3 {
  /** Endpoint to configure the client with. */
  endpoint: string
  /** Stored objects, keyed exactly as the request addressed them. */
  objects: Map<string, Uint8Array>
  /** Every request, in arrival order. */
  seen: SeenRequest[]
  /** Stop listening. */
  close(): Promise<void>
}

/** Bucket every fake service serves. */
export const BUCKET = 'dsh-attachments'

/** How one fake service behaves. */
export interface FakeS3Options {
  /** Bucket name the service answers for. */
  bucket?: string
}

/**
 * Start one fake service on an ephemeral loopback port.
 * @param options - bucket name and metadata behavior.
 * @returns the running service; the caller closes it.
 */
export async function startFakeS3(options: FakeS3Options = {}): Promise<FakeS3> {
  const bucket = options.bucket ?? BUCKET
  const objects = new Map<string, Uint8Array>()
  const seen: SeenRequest[] = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const url = request.url ?? ''
      seen.push({
        method: request.method ?? '',
        url,
        headers: request.headers as Record<string, string | undefined>,
        body: new Uint8Array(Buffer.concat(chunks)),
      })
      const key = decodeURIComponent(url.replace(`/${bucket}/`, '').split('?')[0] ?? '')
      const stored = objects.get(key)

      if (request.method === 'PUT') {
        objects.set(key, new Uint8Array(Buffer.concat(chunks)))
        response.writeHead(200, { etag: '"stored"' })
        response.end()
        return
      }

      if (stored === undefined) {
        response.writeHead(404, { 'content-type': 'application/xml' })
        response.end('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>')
        return
      }

      const range = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range ?? ''))
      const slice = range === null ? stored : stored.subarray(Number(range[1]), Number(range[2]) + 1)
      response.writeHead(range === null ? 200 : 206, { 'content-length': String(slice.byteLength) })
      response.end(Buffer.from(slice))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

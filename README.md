# @guaguasong/dsh-attachment-s3

English | [中文](README.zh.md)

S3 storage for the DeepSeek Harness attachment seam. It implements [`AttachmentStore`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/attachment/attachment) — the same abstract service the in-box `@deepseek-ai/dsh-attachment-local` backend implements over `DSH_HOME` — so a deployment's session images live in a bucket instead of on the machine that admitted them. The seam takes exactly one provider, so this plugin replaces the local backend rather than joining it.

Nothing about the bucket is model-visible: the durable reference stays the opaque `sha256:` id already recorded in the session log, so moving between backends does not change what a transcript means.

## Install

```sh
dsh plugin --profile <name> add @guaguasong/dsh-attachment-s3
export DSH_ATTACHMENT_S3_BUCKET=my-attachments
export DSH_ATTACHMENT_S3_REGION=us-east-1
dsh --profile <name>
```

The package declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, so `dsh plugin` appends it to the profile's bundle layer stack. Its patch disables the `attachment-local` row `dsh-base` inserts and adds the `attachment-s3` row. Check both before booting:

```sh
dsh --profile <name> --dump-config | grep -A2 'id: attachment'
```

`dsh plugin --profile <name> remove @guaguasong/dsh-attachment-s3` reverses the install and restores the local backend.

### Environment

The bundle patch reads its values from the environment at mount. `DSH_`-prefixed names must come from the launching environment — `export` them or set them in the unit that starts dsh; the launcher refuses that prefix inside a `.env` file. Credential *values* are yours to name, so they can live in `$DSH_HOME/.env`.

| Variable | Config field |
|---|---|
| `DSH_ATTACHMENT_S3_BUCKET` | `bucket` — required; unset fails the boot on this row rather than storing attachments elsewhere |
| `DSH_ATTACHMENT_S3_REGION` | `region` |
| `DSH_ATTACHMENT_S3_ENDPOINT` | `endpoint` — an S3-compatible service |
| `DSH_ATTACHMENT_S3_FORCE_PATH_STYLE` | `forcePathStyle` — `true` enables it |
| `DSH_ATTACHMENT_S3_PREFIX` | `prefix` |
| `DSH_ATTACHMENT_S3_ACCESS_KEY_ID_REF` | `accessKeyIdRef` — the **name** of the variable holding the key, not the key |
| `DSH_ATTACHMENT_S3_SECRET_ACCESS_KEY_REF` | `secretAccessKeyRef` |
| `DSH_ATTACHMENT_S3_SESSION_TOKEN_REF` | `sessionTokenRef` |
| `DSH_ATTACHMENT_S3_VARIANT_CACHE_DIR` | `variantCacheDir` |

To pin configuration instead of reading the environment, restate the row in `$DSH_HOME/profiles/<name>/cordis.patch.yml`, which is applied after every bundle layer. An id-targeted patch replaces the row's whole `config`, so restate the fields you keep:

```yaml
- id: attachment-s3
  name: '@guaguasong/dsh-attachment-s3'
  config:
    bucket: my-attachments
    region: us-east-1
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `bucket` | — (required) | Bucket holding every attachment object. |
| `region` | SDK resolution | Bucket region. |
| `endpoint` | AWS S3 | Endpoint of an S3-compatible service. |
| `forcePathStyle` | `false` | Path-style addressing, required by most S3-compatible services. |
| `prefix` | `attachments/v1` | Key prefix owning this deployment's objects. |
| `accessKeyIdRef` | — | Environment-variable name holding the access key id. |
| `secretAccessKeyRef` | — | Environment-variable name holding the secret access key. |
| `sessionTokenRef` | — | Environment-variable name holding a session token. |
| `maxImageBytes` | 20 MiB | Maximum encoded bytes for one submitted image. |
| `maxImagesPerMessage` | 20 | Maximum images in one submitted message. |
| `maxMessageImageBytes` | 200 MiB | Maximum aggregate encoded image bytes in one message. |
| `maxImagePixels` | 64,000,000 | Maximum intrinsic width × height for one submitted image. |
| `maxImageDimension` | 8192 | Maximum intrinsic width and height, applied per side. |
| `normalizedImageMaxDimension` | 2048 | Long edge of the stored image; a larger admitted image is downscaled to it. |
| `normalizedImageMaxBytes` | 4 MiB | Byte budget of the stored image. |
| `variantCacheDir` | under the Harness home | Local cache of derived request images. |

Admission, normalization, and request-image derivation are delegated to the in-box `@deepseek-ai/dsh-attachment-local` package, which exports them as plain functions; the defaults above are re-exported from it rather than restated. That keeps one encoder policy across both backends — the same image is accepted, stored, and put in front of a model either way — and leaves this package owning only the bucket. Object policy a bucket already owns — default encryption, storage class, lifecycle — is left to the bucket.

Configuration carries credential **references**, never values, matching the harness [credential seam](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/credentials). Each is resolved per request, through `ctx.credentials` when a credential provider is loaded and through the process environment otherwise, so a rotated secret reaches the next request without a restart. Declare both key references or neither: a half-declared pair fails at load instead of silently signing as the SDK's ambient identity. Declaring neither is the normal deployment on an instance role.

## How it stores

```
<prefix>/objects/<first two hex digits>/<sha256 hex>
```

One immutable object per distinct image, `Content-Type` set to the verified media type, the SHA-256 sent as the object checksum, and the intrinsic `width`/`height` recorded as object metadata. The session log records `sha256:<hex>` — an opaque id, never a key or a URL. The `v1` segment fences a future incompatible layout off from stored objects.

What lands in the bucket is the **normalized** image, not the submitted bytes: admission downscales a large source to the stored long edge and re-encodes it under a byte budget, and the reference records the original dimensions. The version a model request carries is derived from the stored object on demand and cached locally, since it is reproducible and does not belong in the bucket.

- **Write-once.** Uploads are conditional (`If-None-Match: *`), so concurrent writers of identical bytes never overwrite each other. The writer that loses the race verifies what is already stored instead of republishing it: the recorded checksum settles it without moving bytes, and an object stored without one is read back and compared, because a same-length substitution would otherwise publish a reference no later read can return.
- **Verified reads.** A read requests exactly the byte range the reference claims, re-hashes the bytes, and re-derives the image header before returning, so a bucket-side substitution surfaces as `ATTACHMENT_CORRUPT` instead of reaching a model request.
- **Failure codes.** Admission keeps the seam's caller-correctable codes (`IMAGE_TOO_LARGE`, `IMAGE_TYPE_MISMATCH`, `IMAGE_TOO_MANY_PIXELS`, `IMAGE_DIMENSION_TOO_LARGE`, `INVALID_IMAGE`); storage failures surface as `ATTACHMENT_WRITE_FAILED`, `ATTACHMENT_READ_FAILED`, `ATTACHMENT_NOT_FOUND`, or `ATTACHMENT_CORRUPT`, each carrying its cause.

## S3-compatible services

The backend needs four things from a bucket: a conditional write that refuses a taken key, an object checksum it can send and read back, ranged reads, and a distinguishable "no such key". AWS S3 provides all four; other services vary. Probe one before pointing a deployment at it:

```sh
PROBE_ENDPOINT=https://s3.example.com PROBE_REGION=us-east-1 PROBE_BUCKET=<bucket> \
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... pnpm run probe
```

It writes and deletes one small object and reports what the service does with each behavior. A service that **ignores** the conditional write still works: the key is the digest of the bytes, so an overwrite writes exactly what is already there, and the writer publishing the reference is the one that wrote it — storage still deduplicates, only the upload repeats. A service that **rejects** the conditional write or the checksum header cannot run this backend as it stands.

## Development

```sh
pnpm install       # runs `prepare`, which builds lib/
pnpm run test      # unit tests, including the real AWS SDK against a loopback S3-compatible service
pnpm run typecheck
pnpm run build
pnpm run test:e2e  # real bucket; self-skips without DSH_S3_E2E_BUCKET
```

`pnpm run test` needs no bucket and no network: `tests/support/fake-s3.ts` serves the S3 requests the SDK actually sends, so signing, conditional writes, range reads, and status classification are exercised for real. The e2e suite reads `DSH_S3_E2E_BUCKET` and optionally `DSH_S3_E2E_REGION`, `DSH_S3_E2E_ENDPOINT`, `DSH_S3_E2E_FORCE_PATH_STYLE`, and `DSH_S3_E2E_PREFIX`; it writes under a random per-run prefix and deletes what it wrote.

Publishing runs `prepublishOnly` first: clean, typecheck, the full suite, then build.

## Known Limitations and Deferred Work

- **No retention or deletion.** Objects are written and never removed; the seam has no retention policy on either backend. Bucket lifecycle rules are the only collector, and expiring an object a session still references turns that attachment into `ATTACHMENT_NOT_FOUND`.
- **Images only.** The seam's version-one surface carries PNG, JPEG, WebP, and GIF.
- **One bucket per deployment.** Routing sessions or workspaces to different buckets would need a routing layer this package does not have.
- **Full-object transfers.** Reads buffer the whole image in memory, bounded by `maxImageBytes`.
- **Sharing needs more than attachments.** Session logs stay wherever the profile's persistence backend puts them — by default `$DSH_HOME/sessions`, which is machine-local. A bucket makes attachments durable and centrally managed; it does not by itself make a session readable from another machine.

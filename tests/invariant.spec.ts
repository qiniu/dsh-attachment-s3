import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import S3AttachmentStore from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

describe('invariant companion', () => {
  it('reserves package ownership once the attachment seam is provided', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(S3AttachmentStore, { bucket: 'dsh-attachments', region: 'us-east-1' })

    await expect(ctx.plugin(invariant).await()).resolves.toBeDefined()
  })
})

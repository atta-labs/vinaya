import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LogEventSchema } from './schema'
import { describeSchema, logEventSchemaDigest, schemaDigest } from './schema-digest'

/**
 * The digest names which lines a validator accepts: it moves when one key
 * does, it never moves for a reordering that accepts the same lines, and it
 * is computed from the validator's structure rather than from anything a
 * person has to remember to bump.
 */

const here = dirname(fileURLToPath(import.meta.url))

function base() {
  return z
    .object({
      meta: z.object({ schema: z.literal(3), event_id: z.string().min(1) }).strict(),
      kind: z.literal('gate'),
      reason: z.string().optional()
    })
    .strict()
}

describe('schemaDigest', () => {
  it('differs for two validators that differ by one key', () => {
    const withExtra = base().extend({ extra: z.string() }).strict()
    expect(schemaDigest(withExtra)).not.toBe(schemaDigest(base()))
  })

  it('differs for one nested key, one literal, one enum value and one string bound', () => {
    const nested = z
      .object({
        meta: z.object({ schema: z.literal(3), event_id: z.string().min(1), extra: z.null() }).strict(),
        kind: z.literal('gate'),
        reason: z.string().optional()
      })
      .strict()
    const literal = base()
      .extend({ kind: z.literal('usage') })
      .strict()
    const bound = base()
      .extend({ reason: z.string().max(10).optional() })
      .strict()
    const digests = [base(), nested, literal, bound].map(schemaDigest)
    expect(new Set(digests).size).toBe(4)
    expect(schemaDigest(z.enum(['a', 'b']))).not.toBe(schemaDigest(z.enum(['a', 'b', 'c'])))
  })

  it('is the same for a validator whose keys and union members are declared in another order', () => {
    const a = z.union([z.object({ x: z.string(), y: z.number() }).strict(), z.literal('n')])
    const b = z.union([z.literal('n'), z.object({ y: z.number(), x: z.string() }).strict()])
    expect(schemaDigest(a)).toBe(schemaDigest(b))
    expect(schemaDigest(z.enum(['b', 'a']))).toBe(schemaDigest(z.enum(['a', 'b'])))
  })

  it('differs when an object stops refusing unknown keys', () => {
    expect(schemaDigest(base().passthrough())).not.toBe(schemaDigest(base()))
  })

  it('names every key the event validator accepts in its description', () => {
    const text = JSON.stringify(describeSchema(LogEventSchema))
    for (const key of ['event_id', 'provenance', 'loop_id', 'deferral_reason', 'error_class']) {
      expect(text).toContain(`"${key}":`)
    }
  })

  it('refuses a validator node it cannot describe rather than skipping it', () => {
    const odd = { _def: { typeName: 'ZodSomethingNew' } } as unknown as z.ZodTypeAny
    expect(() => schemaDigest(z.object({ a: odd }))).toThrow(/ZodSomethingNew/)
  })
})

describe('logEventSchemaDigest', () => {
  it('is a sha256 of the bundled event validator', () => {
    expect(logEventSchemaDigest()).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(logEventSchemaDigest()).toBe(schemaDigest(LogEventSchema))
  })

  it('is the same in a second process', () => {
    const script = `import { logEventSchemaDigest } from ${JSON.stringify(join(here, 'schema-digest.ts'))}; process.stdout.write(logEventSchemaDigest())`
    const child = spawnSync('bun', ['-e', script], { encoding: 'utf8' })
    expect(child.status).toBe(0)
    expect(child.stdout).toBe(logEventSchemaDigest())
  })
})

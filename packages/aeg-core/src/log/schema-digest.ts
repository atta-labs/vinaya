/**
 * The event validator's structural digest: one short string that names exactly
 * which lines a build of `LogEventSchema` accepts, so two processes can tell
 * whether they validate the same way without sharing anything but the string.
 *
 * The log server reports the digest of the validator it bundled on its stats
 * route, and the CLI compares it with its own (`vinaya log selftest`,
 * `vinaya doctor`). A server whose digest differs was deployed from an older
 * (or newer) schema, and refuses or stores verbatim lines the sender considers
 * valid — the drift a rejected-row count only shows after the events are lost.
 *
 * The digest is computed from the validator's own structure, never from a
 * hand-maintained constant, the package version or the source file's text: a
 * walk over the zod definition tree produces a canonical description (every
 * object's keys, sorted; every union's members, sorted; every literal, enum
 * value and string or number check), and the digest is that description's
 * SHA-256. Two validators that accept a different key differ in the
 * description, so in the digest; the same validator yields the same
 * description in any process, because nothing in it depends on declaration
 * order, object identity or the runtime.
 *
 * What a walk cannot see is a refinement's body — `.refine(fn)` is opaque
 * code. The description records that a refinement is there, and where, but a
 * change to its predicate alone does not change the digest.
 */

import { createHash } from 'node:crypto'
import type { ZodTypeAny } from 'zod'
import { LogEventSchema } from './schema'

/** A node of the canonical description — plain JSON, so its serialization is the whole of its identity. */
type Shape = null | boolean | number | string | Shape[] | { [key: string]: Shape }

type Def = Record<string, unknown> & { typeName?: string }

function defOf(schema: unknown): Def {
  const def = (schema as { _def?: unknown } | null)?._def
  if (def === null || typeof def !== 'object') {
    throw new Error('schema digest: a node of the validator carries no definition to walk')
  }
  return def as Def
}

/** Serialization used for both sorting and hashing: key order inside `describe`'s output is already fixed. */
function serialize(shape: Shape): string {
  return JSON.stringify(shape)
}

/** Members whose order carries no meaning (union options, enum values, checks), in one canonical order. */
function sortedShapes(shapes: Shape[]): Shape[] {
  return shapes
    .map((shape) => [serialize(shape), shape] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, shape]) => shape)
}

/** A string, number or array check: its kind and every bound or pattern it holds. */
function describeChecks(checks: unknown): Shape[] {
  if (!Array.isArray(checks)) return []
  return sortedShapes(
    checks.map((check: Record<string, unknown>) => {
      const out: { [key: string]: Shape } = { kind: String(check.kind) }
      for (const key of Object.keys(check).sort()) {
        if (key === 'kind' || key === 'message') continue
        const value = check[key]
        if (value instanceof RegExp) out[key] = { source: value.source, flags: value.flags }
        else if (value === undefined) continue
        else out[key] = value as Shape
      }
      return out
    })
  )
}

function lengthBound(value: unknown): Shape {
  if (value === null || typeof value !== 'object') return null
  return (value as { value?: number }).value ?? null
}

/**
 * The canonical description of one validator node. A construct this walk does
 * not know is an error, never a silent skip: a digest that ignored part of the
 * validator would report two different validators as the same one.
 */
function describe(schema: ZodTypeAny, walking: Set<unknown>): Shape {
  const def = defOf(schema)
  const type = def.typeName
  switch (type) {
    case 'ZodString':
    case 'ZodNumber':
    case 'ZodBigInt':
    case 'ZodDate':
      return { type, checks: describeChecks(def.checks) }
    case 'ZodBoolean':
    case 'ZodNull':
    case 'ZodUndefined':
    case 'ZodAny':
    case 'ZodUnknown':
    case 'ZodNever':
    case 'ZodVoid':
    case 'ZodNaN':
    case 'ZodSymbol':
      return { type }
    case 'ZodLiteral':
      return { type, value: def.value as Shape }
    case 'ZodEnum':
      return { type, values: [...(def.values as string[])].sort() }
    case 'ZodNativeEnum':
      return { type, values: sortedShapes(Object.values(def.values as Record<string, Shape>)) }
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)()
      const keys: { [key: string]: Shape } = {}
      for (const key of Object.keys(shape).sort()) keys[key] = describe(shape[key] as ZodTypeAny, walking)
      const catchall = def.catchall as ZodTypeAny
      return {
        type,
        unknownKeys: String(def.unknownKeys),
        catchall: defOf(catchall).typeName === 'ZodNever' ? null : describe(catchall, walking),
        keys
      }
    }
    case 'ZodArray':
      return {
        type,
        element: describe(def.type as ZodTypeAny, walking),
        minLength: lengthBound(def.minLength),
        maxLength: lengthBound(def.maxLength),
        exactLength: lengthBound(def.exactLength)
      }
    case 'ZodUnion':
      return { type, options: sortedShapes((def.options as ZodTypeAny[]).map((o) => describe(o, walking))) }
    case 'ZodDiscriminatedUnion':
      return {
        type,
        discriminator: String(def.discriminator),
        options: sortedShapes((def.options as ZodTypeAny[]).map((o) => describe(o, walking)))
      }
    case 'ZodIntersection':
      return {
        type,
        sides: sortedShapes([describe(def.left as ZodTypeAny, walking), describe(def.right as ZodTypeAny, walking)])
      }
    case 'ZodTuple':
      return {
        type,
        items: (def.items as ZodTypeAny[]).map((item) => describe(item, walking)),
        rest: def.rest === null || def.rest === undefined ? null : describe(def.rest as ZodTypeAny, walking)
      }
    case 'ZodRecord':
    case 'ZodMap':
      return {
        type,
        key: describe(def.keyType as ZodTypeAny, walking),
        value: describe(def.valueType as ZodTypeAny, walking)
      }
    case 'ZodSet':
      return {
        type,
        element: describe(def.valueType as ZodTypeAny, walking),
        minSize: lengthBound(def.minSize),
        maxSize: lengthBound(def.maxSize)
      }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodReadonly':
      return { type, inner: describe(def.innerType as ZodTypeAny, walking) }
    case 'ZodDefault':
    case 'ZodCatch':
      // The fallback value is produced, never validated, so it changes no
      // line's acceptance; only the wrapped validator does.
      return { type, inner: describe(def.innerType as ZodTypeAny, walking) }
    case 'ZodBranded':
      return { type, inner: describe(def.type as ZodTypeAny, walking) }
    case 'ZodEffects': {
      const effect = def.effect as { type?: unknown } | undefined
      return { type, effect: String(effect?.type), inner: describe(def.schema as ZodTypeAny, walking) }
    }
    case 'ZodPipeline':
      return { type, in: describe(def.in as ZodTypeAny, walking), out: describe(def.out as ZodTypeAny, walking) }
    case 'ZodLazy': {
      // A self-referencing validator would recurse forever; the second visit
      // of a lazy node describes the reference, not the node again.
      if (walking.has(schema)) return { type, recursive: true }
      walking.add(schema)
      const inner = describe((def.getter as () => ZodTypeAny)(), walking)
      walking.delete(schema)
      return { type, inner }
    }
    default:
      throw new Error(`schema digest: the validator holds a ${String(type)} node, which this walk does not describe`)
  }
}

/**
 * The canonical description of a validator — the value `schemaDigest` hashes.
 * Exported so a test can show what the digest covers, never for comparison:
 * compare digests.
 */
export function describeSchema(schema: ZodTypeAny): Shape {
  return describe(schema, new Set())
}

/**
 * `sha256:<hex>` of a validator's canonical description. The same validator
 * gives the same digest in every process and runtime; validators that accept
 * a different key, literal, enum value or string/number bound give different
 * ones.
 */
export function schemaDigest(schema: ZodTypeAny): string {
  return `sha256:${createHash('sha256')
    .update(serialize(describeSchema(schema)))
    .digest('hex')}`
}

let eventSchemaDigest: string | null = null

/**
 * The digest of `LogEventSchema` as this build bundles it — what the log
 * server reports on its stats route and what the CLI compares that against.
 * Computed once per process: the validator never changes while it runs.
 */
export function logEventSchemaDigest(): string {
  eventSchemaDigest ??= schemaDigest(LogEventSchema)
  return eventSchemaDigest
}

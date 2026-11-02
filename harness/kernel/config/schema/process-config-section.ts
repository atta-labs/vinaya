import type { z } from 'zod'
import type { KernelConfig } from './config-schema.js'

/**
 * A cross-key rule over the whole parsed configuration. A rule that reads
 * kernel keys as well as the section's own receives them in `config`; the
 * issues it adds are reported in the order the rules run.
 */
export type ConfigRefinement<Config> = (config: Config, ctx: z.RefinementCtx) => void

/**
 * A key the machine-wide configuration file may not set: present there, it is
 * stripped at load with `warning(path)` printed once, never resolved.
 */
export type GlobalOnlyKey<Config> = {
  key: string
  present(config: Config): boolean
  warning(path: string): string
}

/**
 * What a process adds to the configuration: the top-level keys it owns, its
 * object fragment (one schema per key), its cross-key refinements, the keys the
 * machine-wide file may not set, and the resolvers that read its keys. The
 * process's composition joins it with `kernelConfigFragment` into one object
 * schema; the kernel never imports a section.
 */
export interface ProcessConfigSection<
  Fragment extends z.ZodRawShape,
  Config extends KernelConfig & z.infer<z.ZodObject<Fragment>>,
  Resolvers
> {
  readonly keys: readonly (keyof Fragment & string)[]
  readonly fragment: Fragment
  readonly refinements: readonly ConfigRefinement<Config>[]
  readonly globalOnlyKeys: readonly GlobalOnlyKey<Config>[]
  readonly resolvers: Resolvers
}

/**
 * One object shape holding every key of `fragments`, in `order`. Each key of
 * every fragment must be named exactly once and no fragment may repeat
 * another's key: the order decides the order an object's issues are reported
 * in, so a key with no declared place is refused rather than appended.
 */
export function orderedShape<Shape extends z.ZodRawShape>(
  order: readonly string[],
  ...fragments: z.ZodRawShape[]
): Shape {
  const owners = new Map<string, z.ZodTypeAny>()
  for (const fragment of fragments) {
    for (const [key, schema] of Object.entries(fragment)) {
      if (owners.has(key)) throw new Error(`configuration key "${key}" is declared by two fragments`)
      owners.set(key, schema)
    }
  }
  const shape: z.ZodRawShape = {}
  for (const key of order) {
    const schema = owners.get(key)
    if (!schema) throw new Error(`configuration key "${key}" has a place in the order but no fragment declares it`)
    if (key in shape) throw new Error(`configuration key "${key}" is placed twice in the order`)
    shape[key] = schema
  }
  for (const key of owners.keys()) {
    if (!(key in shape)) throw new Error(`configuration key "${key}" is declared but has no place in the order`)
  }
  return shape as Shape
}

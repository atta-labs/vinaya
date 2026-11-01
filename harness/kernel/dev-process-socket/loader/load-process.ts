import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

// Reads a process folder: validates its `process.yaml` against the process
// contract (`../contract/process.schema.json`, mirrored here as a zod schema),
// resolves every declared path inside the folder, and pins a SHA-256 digest over
// `process.yaml` plus every declared file. The loader knows no particular
// process and does not compile the Flow.
//
// A process declares its Flow one of two ways: `flow` (one Flow file) or
// `flows` (a map from a flow key to a Flow file, with `default_flow` naming the
// one a run gets when it chooses none, else `v1`, else the first key). A run
// chooses its flow by key (`loadProcess(folder, { flow })`); a `flow`-only
// process answers to the key `default`. The digest pins every declared Flow,
// so two runs of one process version share one digest whichever flow they ran.

export const PROCESS_FILE = 'process.yaml'

const nonEmpty = z.string().min(1)

/** A flow key: what a run names to choose its flow (`v1`, `v2`). */
const flowKey = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a flow key is lower-case letters, digits and dashes')

/** The process file's fields, before the cross-field rules. */
export const processFields = z
  .object({
    id: nonEmpty,
    name: nonEmpty.optional(),
    version: nonEmpty,
    flow: nonEmpty.optional(),
    flows: z
      .record(flowKey, nonEmpty)
      .refine((flows) => Object.keys(flows).length > 0, 'flows names at least one flow')
      .optional(),
    default_flow: flowKey.optional(),
    roles: z.array(nonEmpty).min(1)
  })
  .strict()

export const processSchema = processFields.superRefine((value, ctx) => {
  if ((value.flow === undefined) === (value.flows === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['flow'], message: 'declare exactly one of flow or flows' })
  }
  if (value.default_flow !== undefined && (value.flows === undefined || !(value.default_flow in value.flows))) {
    ctx.addIssue({ code: 'custom', path: ['default_flow'], message: 'default_flow must name a key of flows' })
  }
})

/** The key a `flow`-only process answers to. */
export const SINGLE_FLOW_KEY = 'default'

export type ProcessIdentity = z.infer<typeof processSchema>

export type ProcessLoadReason =
  | 'missing-process-file'
  | 'unparseable-yaml'
  | 'schema-violation'
  | 'declared-path-missing'
  | 'declared-path-escapes'
  | 'unknown-flow'

export class ProcessLoadError extends Error {
  constructor(
    readonly reason: ProcessLoadReason,
    message: string,
    readonly field?: string
  ) {
    super(message)
    this.name = 'ProcessLoadError'
  }
}

export interface LoadedProcess {
  folder: string
  identity: ProcessIdentity
  /** The chosen flow's key: a `flows` key, or `default` for a `flow`-only process. */
  flowKey: string
  /** The chosen flow's file. */
  flowPath: string
  /** Every declared flow's file, by key. */
  flowPaths: Record<string, string>
  rolePaths: string[]
  digest: string
}

function resolveInside(folder: string, declared: string, field: string): string {
  const resolved = resolve(folder, declared)
  const rel = relative(folder, resolved)
  if (isAbsolute(declared) || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new ProcessLoadError('declared-path-escapes', `${field} "${declared}" escapes the process folder`, field)
  }
  if (!existsSync(resolved)) {
    throw new ProcessLoadError('declared-path-missing', `${field} "${declared}" does not exist`, field)
  }
  return resolved
}

function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path)
    .sort()
    .flatMap((entry) => filesUnder(join(path, entry)))
}

function pin(folder: string, processFile: string, declared: string[]): string {
  const files = [processFile, ...declared.flatMap(filesUnder)]
  const hash = createHash('sha256')
  for (const file of [...new Set(files)].sort()) {
    const content = readFileSync(file)
    hash.update(`${relative(folder, file)}\0${content.length}\0`)
    hash.update(content)
  }
  return hash.digest('hex')
}

/** The flow key a run gets when it names none. */
export function defaultFlowKey(identity: ProcessIdentity): string {
  if (!identity.flows) return SINGLE_FLOW_KEY
  if (identity.default_flow) return identity.default_flow
  if ('v1' in identity.flows) return 'v1'
  return Object.keys(identity.flows)[0] as string
}

export interface LoadProcessOptions {
  /** The flow key the run chooses; absent takes the process's default. */
  flow?: string
}

export function loadProcess(folderPath: string, options: LoadProcessOptions = {}): LoadedProcess {
  const folder = resolve(folderPath)
  const processFile = join(folder, PROCESS_FILE)
  if (!existsSync(processFile)) {
    throw new ProcessLoadError('missing-process-file', `${PROCESS_FILE} not found in ${folder}`)
  }

  let raw: unknown
  try {
    raw = parse(readFileSync(processFile, 'utf8'))
  } catch (error) {
    throw new ProcessLoadError('unparseable-yaml', `${PROCESS_FILE} is not valid YAML: ${(error as Error).message}`)
  }

  const result = processSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const field = issue?.path.join('.') || '(root)'
    throw new ProcessLoadError('schema-violation', `${PROCESS_FILE} field ${field}: ${issue?.message}`, field)
  }
  const identity = result.data

  const declaredFlows: Record<string, string> = identity.flows ?? { [SINGLE_FLOW_KEY]: identity.flow as string }
  const flowPaths: Record<string, string> = {}
  for (const [key, declared] of Object.entries(declaredFlows)) {
    flowPaths[key] = resolveInside(folder, declared, identity.flows ? `flows.${key}` : 'flow')
  }
  const flowKey = options.flow ?? defaultFlowKey(identity)
  const flowPath = flowPaths[flowKey]
  if (flowPath === undefined) {
    throw new ProcessLoadError(
      'unknown-flow',
      `flow "${flowKey}" is not declared; ${PROCESS_FILE} declares ${Object.keys(flowPaths).join(', ')}`,
      'flow'
    )
  }
  const rolePaths = identity.roles.map((role, index) => resolveInside(folder, role, `roles.${index}`))

  return {
    folder,
    identity,
    flowKey,
    flowPath,
    flowPaths,
    rolePaths,
    digest: pin(folder, processFile, [...Object.values(flowPaths), ...rolePaths])
  }
}

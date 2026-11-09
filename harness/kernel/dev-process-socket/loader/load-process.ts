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
//
// A process may also declare `provides`: every role by name (its doctrine,
// and for a launched role — one listed in `roles` — its grants and output
// schema), plus the modules that supply its checks, policies, configuration
// section and kernel integration. The loader resolves each path inside the
// folder, refuses a launched role with no declaration
// (`launched-role-undeclared`), and pins every declared file in the digest. It
// never imports a declared module: the composition roots do, where the bundler
// sees them.

export const PROCESS_FILE = 'process.yaml'

const nonEmpty = z.string().min(1)

/** A flow key: what a run names to choose its flow (`v1`, `v2`). */
const flowKey = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a flow key is lower-case letters, digits and dashes')

/** A role name: the last segment of a launched role's folder, and a `provides.roles` key. */
const roleName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a role name is lower-case letters, digits and dashes')

/** One role's declaration: its doctrine always; its grants and output schema when the harness launches it. */
export const providedRoleSchema = z
  .object({
    doctrine: nonEmpty,
    grants: nonEmpty.optional(),
    output_schema: nonEmpty.optional(),
    tools: nonEmpty.optional()
  })
  .strict()

/** Everything a process provides beyond its flows and launched role folders, each a path inside the folder. */
export const providesSchema = z
  .object({
    roles: z
      .record(roleName, providedRoleSchema)
      .refine((roles) => Object.keys(roles).length > 0, 'provides.roles names at least one role'),
    checks: nonEmpty,
    policies: nonEmpty,
    config_section: nonEmpty,
    integration: nonEmpty
  })
  .strict()

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
    roles: z.array(nonEmpty).min(1),
    provides: providesSchema.optional()
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
  | 'launched-role-undeclared'

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
  /** `provides` resolved inside the folder; absent when the process declares none. */
  provided?: ProvidedPaths
  digest: string
}

export interface ProvidedRolePaths {
  doctrine: string
  grants?: string
  outputSchema?: string
  tools?: string
}

export interface ProvidedPaths {
  roles: Record<string, ProvidedRolePaths>
  checks: string
  policies: string
  configSection: string
  integration: string
}

/** A launched role's name: the last segment of its folder path. */
export function launchedRoleName(declared: string): string {
  const segments = declared.split('/').filter((segment) => segment !== '' && segment !== '.')
  return segments[segments.length - 1] ?? declared
}

function resolveProvides(folder: string, identity: ProcessIdentity): ProvidedPaths | undefined {
  const provides = identity.provides
  if (!provides) return undefined
  for (const declared of identity.roles) {
    const name = launchedRoleName(declared)
    const role = provides.roles[name]
    if (!role) {
      throw new ProcessLoadError(
        'launched-role-undeclared',
        `launched role "${declared}" has no declaration at provides.roles.${name}`,
        `provides.roles.${name}`
      )
    }
    for (const part of ['grants', 'output_schema'] as const) {
      if (role[part] === undefined) {
        const field = `provides.roles.${name}.${part}`
        throw new ProcessLoadError(
          'launched-role-undeclared',
          `launched role "${declared}" declares no ${field}`,
          field
        )
      }
    }
  }
  const roles: Record<string, ProvidedRolePaths> = {}
  for (const [name, role] of Object.entries(provides.roles)) {
    const at = (part: string) => `provides.roles.${name}.${part}`
    roles[name] = {
      doctrine: resolveInside(folder, role.doctrine, at('doctrine')),
      ...(role.grants !== undefined ? { grants: resolveInside(folder, role.grants, at('grants')) } : {}),
      ...(role.output_schema !== undefined
        ? { outputSchema: resolveInside(folder, role.output_schema, at('output_schema')) }
        : {}),
      ...(role.tools !== undefined ? { tools: resolveInside(folder, role.tools, at('tools')) } : {})
    }
  }
  return {
    roles,
    checks: resolveInside(folder, provides.checks, 'provides.checks'),
    policies: resolveInside(folder, provides.policies, 'provides.policies'),
    configSection: resolveInside(folder, provides.config_section, 'provides.config_section'),
    integration: resolveInside(folder, provides.integration, 'provides.integration')
  }
}

function providedFiles(provided: ProvidedPaths | undefined): string[] {
  if (!provided) return []
  const roleFiles = Object.values(provided.roles).flatMap((role) =>
    [role.doctrine, role.grants, role.outputSchema, role.tools].filter((path): path is string => path !== undefined)
  )
  return [...roleFiles, provided.checks, provided.policies, provided.configSection, provided.integration]
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
  const provided = resolveProvides(folder, identity)

  return {
    folder,
    identity,
    flowKey,
    flowPath,
    flowPaths,
    rolePaths,
    ...(provided ? { provided } : {}),
    digest: pin(folder, processFile, [...Object.values(flowPaths), ...rolePaths, ...providedFiles(provided)])
  }
}

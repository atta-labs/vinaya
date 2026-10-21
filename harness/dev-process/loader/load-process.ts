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

export const PROCESS_FILE = 'process.yaml'

const nonEmpty = z.string().min(1)

export const processSchema = z
  .object({
    id: nonEmpty,
    name: nonEmpty.optional(),
    version: nonEmpty,
    flow: nonEmpty,
    roles: z.array(nonEmpty).min(1)
  })
  .strict()

export type ProcessIdentity = z.infer<typeof processSchema>

export type ProcessLoadReason =
  | 'missing-process-file'
  | 'unparseable-yaml'
  | 'schema-violation'
  | 'declared-path-missing'
  | 'declared-path-escapes'

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
  flowPath: string
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

export function loadProcess(folderPath: string): LoadedProcess {
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

  const flowPath = resolveInside(folder, identity.flow, 'flow')
  const rolePaths = identity.roles.map((role, index) => resolveInside(folder, role, `roles.${index}`))

  return { folder, identity, flowPath, rolePaths, digest: pin(folder, processFile, [flowPath, ...rolePaths]) }
}

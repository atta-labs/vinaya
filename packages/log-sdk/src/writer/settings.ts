import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { type CustomEventDeclarations, CustomEventDeclarationsSchema } from '../contract/custom.js'

/*
 * The settings reader mirrors the harness schema's rules for the `logs` and
 * `runtimeDir` keys without importing the harness: the package stands alone.
 */

const absolutePath = (label: string) =>
  z
    .string()
    .min(1)
    .refine((v) => isAbsolute(v), { message: `${label}: must be an absolute path` })

/** How many days a run's local copy is kept when the settings name no window. */
export const DEFAULT_KEEP_DAYS = 90

const keepDaysSchema = z
  .number({ invalid_type_error: 'must be a whole number of days' })
  .int({ message: 'must be a whole number of days' })
  .min(1, { message: 'must be at least 1' })

const logsObject = z
  .object({
    folder: absolutePath('logs.folder').optional(),
    url: z.string().url().optional(),
    otlp: z
      .object({
        url: z
          .string()
          .url()
          .regex(/^https?:\/\//i),
        headers: z.record(z.string()).optional()
      })
      .strict()
      .optional(),
    headers: z.record(z.string()).optional(),
    readHeaders: z.record(z.string()).optional(),
    keepDays: keepDaysSchema.optional(),
    events: z.unknown().optional()
  })
  .strict()
  .refine((v) => [v.folder, v.url].filter((x) => x !== undefined).length <= 1, {
    message: 'logs: set at most one of folder/url'
  })
  .refine((v) => v.headers === undefined || v.url !== undefined, { message: 'logs: headers requires url' })
  .refine((v) => v.readHeaders === undefined || v.url !== undefined, { message: 'logs: readHeaders requires url' })

const logsSchema = logsObject.or(z.literal(false))
const runtimeDirSchema = absolutePath('runtimeDir')

const logConfigSchema = z.object({ logs: logsSchema.optional(), runtimeDir: runtimeDirSchema.optional() }).strict()

export type LogsSetting = z.infer<typeof logsSchema>

/** What a caller may pass to override the settings files. */
export type PassedSettings = {
  destination?: LogsSetting
  /** The keep window in days; it replaces the settings files' `logs.keepDays`. */
  keepDays?: number
  headers?: Record<string, string>
  runtimeDir?: string
}

export type ResolvedSettings = {
  /** `false` when the repository turned the Log off; `undefined` when nothing is configured. */
  logs: LogsSetting | undefined
  runtimeDir: string
  /** Days a local-copy file is kept after its last write. */
  keepDays: number
}

export type SettingsResult =
  | { ok: true; settings: ResolvedSettings; declarations: CustomEventDeclarations }
  | { ok: false; error: Error }

export const MAX_COMPONENT_BYTES = 255
const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

function safeSegment(s: string): boolean {
  return SAFE_SEGMENT.test(s) && !s.includes('..')
}

/** `<owner>-<repo>`, or `unresolved` when either part is unsafe or the combined name is too long. */
export function repoSegment(repository: string | undefined): string {
  const [owner, repo, ...rest] = (repository ?? '').split('/')
  if (!owner || !repo || rest.length > 0 || !safeSegment(owner) || !safeSegment(repo)) return 'unresolved'
  const segment = `${owner}-${repo}`
  return Buffer.byteLength(segment) <= MAX_COMPONENT_BYTES ? segment : 'unresolved'
}

/** The default runtime directory: `<Vinaya home>/runtime/<owner>-<repo>`. */
export function defaultRuntimeDir(
  repository: string | undefined,
  vinayaHome: string = join(homedir(), '.vinaya')
): string {
  return join(vinayaHome, 'runtime', repoSegment(repository))
}

function fail(message: string): SettingsResult {
  return { ok: false, error: new Error(message) }
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (e) {
    return { ok: false, error: new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`) }
  }
}

/** The union with `false` hides which key failed, so `logs.keepDays` is checked on its own first. */
function keepDaysIssue(logs: unknown): string | undefined {
  if (logs === null || typeof logs !== 'object' || Array.isArray(logs) || !('keepDays' in logs)) return undefined
  const checked = keepDaysSchema.safeParse((logs as { keepDays: unknown }).keepDays)
  return checked.success ? undefined : `logs.keepDays ${checked.error.issues.map((i) => i.message).join('; ')}`
}

function zodMessage(label: string, e: z.ZodError): string {
  return `${label}: ${e.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`
}

export function resolveSettings(input: {
  repoRoot: string
  repository?: string
  vinayaHome?: string
  passed?: PassedSettings
}): SettingsResult {
  const passed = input.passed ?? {}
  let fileLogs: LogsSetting | undefined
  let fileRuntimeDir: string | undefined

  const logConfigPath = join(input.repoRoot, 'log.config.json')
  const vinayaConfigPath = join(input.repoRoot, 'vinaya.config.json')
  if (existsSync(logConfigPath)) {
    const read = readJson(logConfigPath)
    if (!read.ok) return { ok: false, error: read.error }
    const keepIssue = keepDaysIssue((read.value as { logs?: unknown } | null)?.logs)
    if (keepIssue) return fail(`${logConfigPath}: ${keepIssue}`)
    const parsed = logConfigSchema.safeParse(read.value)
    if (!parsed.success) return fail(zodMessage(logConfigPath, parsed.error))
    fileLogs = parsed.data.logs
    fileRuntimeDir = parsed.data.runtimeDir
  } else if (existsSync(vinayaConfigPath)) {
    const read = readJson(vinayaConfigPath)
    if (!read.ok) return { ok: false, error: read.error }
    const root = read.value
    if (root === null || typeof root !== 'object' || Array.isArray(root))
      return fail(`${vinayaConfigPath}: must hold one object`)
    const keys = root as Record<string, unknown>
    const keepIssue = keepDaysIssue(keys.logs)
    if (keepIssue) return fail(`${vinayaConfigPath}: ${keepIssue}`)
    const parsed = z
      .object({ logs: logsSchema.optional(), runtimeDir: runtimeDirSchema.optional() })
      .safeParse({ logs: keys.logs, runtimeDir: keys.runtimeDir })
    if (!parsed.success) return fail(zodMessage(vinayaConfigPath, parsed.error))
    fileLogs = parsed.data.logs
    fileRuntimeDir = parsed.data.runtimeDir
  }

  const fileEvents = CustomEventDeclarationsSchema.optional().safeParse(fileLogs ? fileLogs.events : undefined)
  if (!fileEvents.success) return fail(zodMessage('logs.events', fileEvents.error))
  const passedEvents = CustomEventDeclarationsSchema.optional().safeParse(
    passed.destination ? passed.destination.events : undefined
  )
  if (!passedEvents.success) return fail(zodMessage('logs.events', passedEvents.error))
  const declarations = passedEvents.data ?? fileEvents.data ?? {}

  let logs: LogsSetting | undefined = passed.destination !== undefined ? passed.destination : fileLogs
  if (passed.headers !== undefined) {
    if (logs === false) {
      // Turned off: headers have nothing to attach to.
    } else {
      logs = { ...(logs ?? {}), headers: { ...(logs?.headers ?? {}), ...passed.headers } }
    }
  }
  if (logs !== undefined) {
    const checked = logsSchema.safeParse(logs)
    if (!checked.success) return fail(zodMessage('logs', checked.error))
  }

  const passedDir = passed.runtimeDir
  if (passedDir !== undefined) {
    const checked = runtimeDirSchema.safeParse(passedDir)
    if (!checked.success) return fail(zodMessage('runtimeDir', checked.error))
  }
  const runtimeDir = passedDir ?? fileRuntimeDir ?? defaultRuntimeDir(input.repository, input.vinayaHome)
  if (passed.keepDays !== undefined) {
    const checked = keepDaysSchema.safeParse(passed.keepDays)
    if (!checked.success) return fail(zodMessage('logs.keepDays', checked.error))
  }
  // A passed destination replaces the file's `logs`, so the window falls back to the file's own `logs` when none is passed.
  const fileKeepDays = fileLogs === undefined || fileLogs === false ? undefined : fileLogs.keepDays
  const keepDays = passed.keepDays ?? (logs === false ? undefined : logs?.keepDays) ?? fileKeepDays ?? DEFAULT_KEEP_DAYS
  return { ok: true, settings: { logs, runtimeDir, keepDays }, declarations }
}

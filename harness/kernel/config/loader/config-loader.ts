import { execFile, execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { z } from 'zod'
import type { GlobalOnlyKey } from '../schema/process-config-section.js'

// Reading the configuration file: the repository-local file found by walking
// up from the working directory, the machine-wide file, the local override
// file, and the trust-anchor read of the repository's default-branch copy.
// Generic over the composed schema — the process's composition creates one
// loader for its schema and names its own files and messages.

const execFileAsync = promisify(execFile)

/** Plumbing (`git rev-parse`/`git hash-object`) is expected instant; a hang past this is a stuck or hostile `git`, never a slow legitimate answer. */
export const GIT_IDENTITY_TIMEOUT_MS = 5_000

/** A test seam for the trust-anchor read: returns the file's content base64-encoded, as the forge contents API does. */
export type TrustAnchorFetcher = () => string

export type ConfigLoadResult<Config> = { ok: true; config: Config | null } | { ok: false; path: string; error: string }

/** Everything that varies from one process's configuration to another's. */
export type ConfigLoaderOptions<Schema extends z.ZodTypeAny> = {
  schema: Schema
  /** The repository-local file's name, e.g. at the repository root. */
  localFileName: string
  /** The machine-wide home folder; the machine-wide file is `globalFileName` inside it. */
  homeDir: string
  globalFileName: string
  /** Keys stripped from the machine-wide file, in the order they are checked. */
  globalOnlyKeys: readonly GlobalOnlyKey<z.infer<Schema>>[]
  /** Reports an invalid file once — the loader dedupes by path and detail before calling it. */
  reportInvalid(path: string, detail: string): void
  /** The line a swallowed trust-anchor read failure prints, `why` naming the failure. */
  trustAnchorFallbackWarning(why: string): string
}

/** The first line of an error's message — what a warning quotes, so a multi-line `execFileSync` dump never floods the log. */
export function firstLine(err: unknown): string {
  return (err as Error)?.message?.split('\n')[0] ?? 'unknown error'
}

/**
 * Is this failure "the file is not on the default branch"? It inspects the
 * whole error and its `stderr`, never only the first line: `execFileSync`'s
 * message line 1 is "Command failed: <command>", and the forge's 404 text sits
 * below it.
 */
export function isMissingFileError(err: unknown): boolean {
  const stderr = (err as { stderr?: Buffer | string })?.stderr
  const haystack = [
    (err as Error)?.message ?? '',
    typeof stderr === 'string' ? stderr : (stderr?.toString() ?? '')
  ].join('\n')
  return /\b404\b|not found/i.test(haystack)
}

/**
 * Why a fetch failed, in one line: the forge client's own first stderr line
 * when it wrote one, else the message's first line.
 */
export function fetchFailureReason(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string })?.stderr
  const text = (typeof stderr === 'string' ? stderr : (stderr?.toString() ?? '')).trim()
  return text.split('\n')[0]?.trim() || firstLine(err)
}

/** What both trust-anchor fetchers throw when no repository identity resolves. */
export const NO_TRUST_ANCHOR_REPO_MESSAGE = 'could not resolve repo identity for the trust-anchor read'

// One shape gate both identity sources pass through: a crafted remote must not
// produce an `owner/a/b`-shaped value that lands on another contents endpoint.
function wellFormedRepoSlug(slug: string): string | null {
  return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null
}

function trustAnchorRepoFromRunner(): string | null {
  const fromRunner = process.env.GITHUB_REPOSITORY?.trim()
  return fromRunner ? wellFormedRepoSlug(fromRunner) : null
}

function trustAnchorRepoFromRemoteUrl(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/)
  return m?.[1] && m[2] ? wellFormedRepoSlug(`${m[1]}/${m[2]}`) : null
}

/**
 * Repository identity for the trust-anchor read. Order is load-bearing: the
 * Actions runner's own `GITHUB_REPOSITORY` first, the `origin` remote only as
 * a local fallback. The content is read from the forge's server-side state;
 * only this identity comes from the job's own environment.
 */
export function trustAnchorRepo(): string | null {
  const fromRunner = trustAnchorRepoFromRunner()
  if (fromRunner) return fromRunner
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return trustAnchorRepoFromRemoteUrl(url)
  } catch {
    return null
  }
}

/** `trustAnchorRepo`, without ever blocking the event loop — the `origin` fallback runs as an async child. */
export async function trustAnchorRepoAsync(): Promise<string | null> {
  const fromRunner = trustAnchorRepoFromRunner()
  if (fromRunner) return fromRunner
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      // The child dies with the deadline, not only the promise: a hung git left
      // running would hold the event loop open and delay the process's exit.
      timeout: 10_000,
      killSignal: 'SIGKILL'
    })
    return trustAnchorRepoFromRemoteUrl(stdout)
  } catch {
    return null
  }
}

/**
 * The pre-merge probe ref, or `null`. Inside one continuous-integration job —
 * `VINAYA_CI_CONFIG_PROBE_REF` set, `GITHUB_ACTIONS === 'true'` and no forge
 * credential present — both trust-anchor fetchers read the file from this local
 * ref instead of the default branch, so the pull request's configuration stands
 * in for the default branch's. The three facts coincide nowhere else: a run
 * that decides merge authority always carries a credential.
 */
export function resolveCiTrustAnchorProbeRef(env: NodeJS.ProcessEnv = process.env): string | null {
  const ref = env.VINAYA_CI_CONFIG_PROBE_REF?.trim()
  if (!ref) return null
  if (env.GITHUB_ACTIONS !== 'true') return null
  if ((env.GH_TOKEN ?? '').length > 0 || (env.GITHUB_TOKEN ?? '').length > 0) return null
  return ref
}

/**
 * This repository's git common directory — the one directory every worktree
 * of a repository shares — canonicalized so two paths to it compare equal.
 * `null` on any failure, which callers treat as "identity unknown".
 */
export function gitCommonDir(cwd: string = process.cwd()): string | null {
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_IDENTITY_TIMEOUT_MS
    }).trim()
    if (!raw) return null
    return realpathSync(resolve(cwd, raw))
  } catch {
    return null
  }
}

function gitAbsoluteDir(cwd: string): string | null {
  try {
    const raw = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_IDENTITY_TIMEOUT_MS
    }).trim()
    return raw ? realpathSync(raw) : null
  } catch {
    return null
  }
}

function flattenKeys(value: unknown, prefix: string, out: string[]): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flattenKeys(v, prefix ? `${prefix}.${k}` : k, out)
  } else if (prefix) {
    out.push(prefix)
  }
}

/** A local override file that was honoured: its path, its parsed object, and the dotted keys outside the allowlist. */
export type LocalOverrideFile = { path: string; raw: Record<string, unknown>; ignoredKeys: string[] }

export type LocalOverrideOptions = {
  fileName: string
  /** The only dotted keys the file may set; any other is ignored with one warning. */
  overridableKeys: readonly string[]
  /** Environment variables whose presence turns the override off for this process. */
  suppressedBy: readonly string[]
}

const emittedLocalOverrideWarnings = new Set<string>()

/**
 * Reads a local override file, or returns `null` when none is honoured: a
 * suppressing environment variable is set, the working directory is inside a
 * linked worktree, the repository has no primary working tree, or the file is
 * missing or a symlink. The file is looked up at the primary checkout's root
 * (the parent of the git common directory), never by walking up. Invalid JSON
 * or a non-object throws; keys outside the allowlist are ignored with one
 * warning naming them. Validating the allowed values is the caller's.
 */
export function readLocalOverrideFile(
  options: LocalOverrideOptions,
  cwd: string = process.cwd()
): LocalOverrideFile | null {
  if (options.suppressedBy.some((name) => process.env[name])) return null
  const common = gitCommonDir(cwd)
  if (!common || basename(common) !== '.git') return null
  const root = dirname(common)
  // A linked worktree has its own git dir, distinct from the shared common dir.
  if (gitAbsoluteDir(cwd) !== common) return null
  const path = join(root, options.fileName)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    throw new Error(`${options.fileName}: invalid JSON — ${(err as Error).message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${options.fileName}: must be a JSON object — fix the file, this never falls back to a default.`)
  }
  const keys: string[] = []
  flattenKeys(raw, '', keys)
  const ignoredKeys = keys.filter((k) => !options.overridableKeys.includes(k))
  if (ignoredKeys.length > 0) {
    const message = `${path} may only set ${options.overridableKeys.join(', ')} — ignoring ${ignoredKeys.join(', ')}`
    if (!emittedLocalOverrideWarnings.has(message)) {
      emittedLocalOverrideWarnings.add(message)
      console.error(`⚠ ${message}`)
    }
  }
  return { path, raw: raw as Record<string, unknown>, ignoredKeys }
}

/** `path: message` per failing key, joined by `; ` — the detail both loaders report. */
export function schemaIssueDetail(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

/** One process's configuration loader, bound to its schema and its files. */
export function createConfigLoader<Schema extends z.ZodTypeAny>(options: ConfigLoaderOptions<Schema>) {
  type Config = z.infer<Schema>
  const { schema, localFileName, homeDir } = options
  const globalConfigPath = join(homeDir, options.globalFileName)

  /**
   * Walk up from the working directory looking for the local file; `null` if
   * none. The walk never crosses the enclosing repository's own root (`.git`
   * is a folder in a primary checkout, a gitlink file in a linked worktree), so
   * a file planted in a world-writable ancestor never registers commands for a
   * repository below it. Outside any repository it reaches the filesystem root.
   */
  function findLocalConfig(): string | null {
    let dir = process.cwd()
    while (true) {
      const candidate = join(dir, localFileName)
      if (existsSync(candidate)) return candidate
      if (existsSync(join(dir, '.git'))) return null
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }

  /** The active file: the repository-local one, else the machine-wide one, else `null`. */
  function configPath(): string | null {
    const local = findLocalConfig()
    if (local) return local
    if (existsSync(globalConfigPath)) return globalConfigPath
    return null
  }

  /** The folder holding the repository-local file, or `null` when none resolves. */
  function repoLocalConfigDir(): string | null {
    const local = findLocalConfig()
    return local ? dirname(local) : null
  }

  // Each distinct warning prints at most once per process, however many load
  // sites one command reaches.
  const emittedGlobalKeyWarnings = new Set<string>()
  function warnGlobalKeyIgnoredOnce(message: string): void {
    if (emittedGlobalKeyWarnings.has(message)) return
    emittedGlobalKeyWarnings.add(message)
    console.error(`⚠ ${message}`)
  }

  /** Strips every global-only key the machine-wide file set, each with its warning; a repository-local file is returned unchanged. */
  function stripGlobalOnlyKeys(config: Config, path: string): Config {
    if (path !== globalConfigPath) return config
    let result = config
    for (const rule of options.globalOnlyKeys) {
      if (rule.present(result)) {
        warnGlobalKeyIgnoredOnce(rule.warning(path))
        result = { ...result, [rule.key]: undefined }
      }
    }
    return result
  }

  const emittedInvalidConfigReports = new Set<string>()
  function reportInvalidConfigOnce(path: string, detail: string): void {
    const key = `${path}\n${detail}`
    if (emittedInvalidConfigReports.has(key)) return
    emittedInvalidConfigReports.add(key)
    options.reportInvalid(path, detail)
  }

  /** The active file, parsed — `null` when there is none or it is invalid, an invalid file reported once. */
  function loadConfig(): Config | null {
    const path = configPath()
    if (!path) return null
    let text: string
    try {
      text = readFileSync(path, 'utf-8')
    } catch (err) {
      reportInvalidConfigOnce(path, `unreadable: ${(err as Error).message}`)
      return null
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (err) {
      reportInvalidConfigOnce(path, `invalid JSON: ${(err as Error).message}`)
      return null
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      reportInvalidConfigOnce(path, schemaIssueDetail(parsed.error))
      return null
    }
    return stripGlobalOnlyKeys(parsed.data, path)
  }

  /** `loadConfig`'s resolution, returning a parse or validation failure to the caller and reporting nothing itself. */
  function loadConfigChecked(): ConfigLoadResult<Config> {
    const path = configPath()
    if (!path) return { ok: true, config: null }

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (err) {
      return { ok: false, path, error: `invalid JSON: ${(err as Error).message}` }
    }

    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, path, error: schemaIssueDetail(parsed.error) }
    }
    return { ok: true, config: stripGlobalOnlyKeys(parsed.data, path) }
  }

  /** The repository-root file's parsed value at `repoRoot`, or `null` on any read or parse failure — never the walking lookup. */
  function readRepoConfig(repoRoot: string): Config | null {
    const p = join(repoRoot, localFileName)
    if (!existsSync(p)) return null
    try {
      return schema.parse(JSON.parse(readFileSync(p, 'utf-8')))
    } catch {
      return null
    }
  }

  /** Writes the configuration to `<repoRoot or cwd>/<localFileName>` or to the machine-wide file. */
  function writeConfig(scope: 'local' | 'global', config: Config, repoRoot?: string): void {
    let targetPath: string
    if (scope === 'local') {
      const base = repoRoot ?? process.cwd()
      targetPath = join(base, localFileName)
    } else {
      if (!existsSync(homeDir)) {
        mkdirSync(homeDir, { recursive: true })
      }
      targetPath = globalConfigPath
    }
    writeFileSync(targetPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  // ── The trust-anchor read ────────────────────────────────────────────────

  /** The repository's own file at `ref`, base64-encoded as the forge contents API returns it. `git show` reads a committed blob, never the working tree. */
  function readTrustAnchorConfigAtRef(ref: string): string {
    const raw = execFileSync('git', ['show', `${ref}:${localFileName}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000
    })
    return Buffer.from(raw, 'utf-8').toString('base64')
  }

  /**
   * Fetches the file from the repository's default branch through the forge
   * API, with no `ref`, so the forge picks the default branch from server-side
   * settings. The content never comes from local git or the working tree; the
   * pre-merge probe is the one exception, inert outside its one job.
   */
  function fetchTrustAnchorConfig(): string {
    const probeRef = resolveCiTrustAnchorProbeRef()
    if (probeRef) return readTrustAnchorConfigAtRef(probeRef)
    const repo = trustAnchorRepo()
    if (!repo) throw new Error(NO_TRUST_ANCHOR_REPO_MESSAGE)
    return execFileSync('gh', ['api', `repos/${repo}/contents/${localFileName}`, '--jq', '.content'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }

  /** `fetchTrustAnchorConfig`'s async twin — the same read, as an async child that never blocks the event loop. */
  async function fetchTrustAnchorConfigAsync(): Promise<string> {
    const probeRef = resolveCiTrustAnchorProbeRef()
    if (probeRef) {
      const { stdout } = await execFileAsync('git', ['show', `${probeRef}:${localFileName}`], {
        encoding: 'utf-8',
        timeout: 10_000
      })
      return Buffer.from(stdout, 'utf-8').toString('base64')
    }
    const repo = await trustAnchorRepoAsync()
    if (!repo) throw new Error(NO_TRUST_ANCHOR_REPO_MESSAGE)
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${repo}/contents/${localFileName}`, '--jq', '.content'],
      // `SIGKILL` so a hung or unauthenticated client that outlived the timeout
      // is killed rather than left holding the event loop open.
      { encoding: 'utf-8', timeout: 10_000, killSignal: 'SIGKILL' }
    )
    return stdout
  }

  // The fallback line goes to standard output, never standard error: a check's
  // standard error is its check-error channel, where a plain line reads as a
  // malformed check.
  function warnTrustAnchorFallback(why: string): void {
    process.stdout.write(options.trustAnchorFallbackWarning(why))
  }

  // A missing file is silent: a default branch with no file yet is an ordinary state.
  function trustAnchorFetchFailed(err: unknown, warn: (why: string) => void = warnTrustAnchorFallback): null {
    if (!isMissingFileError(err)) warn(firstLine(err))
    return null
  }

  /** Base64 file content to a parsed configuration, or `null` — empty, unreadable as JSON, or outside the schema — with `warn` naming why. */
  function parseTrustAnchorContent(
    content: string,
    warn: (why: string) => void = warnTrustAnchorFallback
  ): Config | null {
    const base64 = content.trim()
    if (!base64) return null
    try {
      const raw = Buffer.from(base64, 'base64').toString('utf-8')
      const parsed = schema.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
      warn('it did not satisfy the config schema')
      return null
    } catch {
      warn('it was not readable as JSON')
      return null
    }
  }

  /**
   * The default branch's file per the forge's own API, never the checkout.
   * Every failure returns `null`, which each resolver turns into its own
   * built-in default — never into trusting unreviewed content. `fetcher` is
   * injectable for tests only.
   */
  function loadTrustAnchorConfig(fetcher: TrustAnchorFetcher = fetchTrustAnchorConfig): Config | null {
    let base64: string
    try {
      base64 = fetcher()
    } catch (err) {
      return trustAnchorFetchFailed(err)
    }
    return parseTrustAnchorContent(base64)
  }

  /**
   * `loadTrustAnchorConfig`, but a genuine read failure — anything other than
   * the file being absent — is thrown rather than swallowed into defaults. A
   * missing file, or a present one that parses to no usable value, is `null`.
   */
  function loadTrustAnchorConfigOrThrow(fetcher: TrustAnchorFetcher = fetchTrustAnchorConfig): Config | null {
    let base64: string
    try {
      base64 = fetcher()
    } catch (err) {
      if (isMissingFileError(err)) return null
      throw new Error(`could not read the trust-anchor config from the default branch: ${firstLine(err)}`)
    }
    return parseTrustAnchorContent(base64)
  }

  /** `loadTrustAnchorConfig` for a caller that must never block the event loop. Same fetch, same fallbacks, same warnings. */
  async function loadTrustAnchorConfigAsync(
    fetcher: () => Promise<string> = fetchTrustAnchorConfigAsync,
    loadOptions: { quiet?: boolean } = {}
  ): Promise<Config | null> {
    const warn = loadOptions.quiet ? () => {} : warnTrustAnchorFallback
    let base64: string
    try {
      base64 = await fetcher()
    } catch (err) {
      return trustAnchorFetchFailed(err, warn)
    }
    return parseTrustAnchorContent(base64, warn)
  }

  return {
    homeDir,
    globalConfigPath,
    localFileName,
    configPath,
    repoLocalConfigDir,
    loadConfig,
    loadConfigChecked,
    readRepoConfig,
    writeConfig,
    fetchTrustAnchorConfig,
    parseTrustAnchorContent,
    loadTrustAnchorConfig,
    loadTrustAnchorConfigOrThrow,
    loadTrustAnchorConfigAsync
  }
}

export type ConfigLoader<Config> = {
  homeDir: string
  globalConfigPath: string
  localFileName: string
  configPath(): string | null
  repoLocalConfigDir(): string | null
  loadConfig(): Config | null
  loadConfigChecked(): ConfigLoadResult<Config>
  readRepoConfig(repoRoot: string): Config | null
  writeConfig(scope: 'local' | 'global', config: Config, repoRoot?: string): void
  fetchTrustAnchorConfig: TrustAnchorFetcher
  parseTrustAnchorContent(content: string, warn?: (why: string) => void): Config | null
  loadTrustAnchorConfig(fetcher?: TrustAnchorFetcher): Config | null
  loadTrustAnchorConfigOrThrow(fetcher?: TrustAnchorFetcher): Config | null
  loadTrustAnchorConfigAsync(fetcher?: () => Promise<string>, options?: { quiet?: boolean }): Promise<Config | null>
}

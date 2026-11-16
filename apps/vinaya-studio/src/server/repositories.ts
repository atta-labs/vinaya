import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { schemaIssueDetail } from '../../../../harness/kernel/config/loader/config-loader.ts'
import { resolveLogsSetting } from '../../../../harness/kernel/config/schema/config-schema.ts'
import { credentialMissing, credentialVarNames } from '../../../../harness/kernel/log/client/log-sync-server-source.ts'
import { resolveRuntimeDir } from '../../../../harness/kernel/run-paths.ts'
import {
  GLOBAL_CONFIG_PATH,
  LOCAL_CONFIG_FILENAME,
  VinayaConfigSchema
} from '../../../../harness/processes/vinaya-strict/integration/config/compose.ts'

/**
 * The repositories one Studio launch observes. The launcher names each checkout explicitly; this module turns every one
 * into a Log source the later live follower reads, using the repository's own configuration under its own root. Nothing
 * here scans the machine, changes the working directory, or reads the forge. This file runs under Node as shipped.
 */

export type RemoteIdentity = { owner: string; repo: string }

/** What the launcher resolved, from local git only, for one checkout. */
export type LaunchRepository = { root: string; remote: RemoteIdentity | null }

/** The server-only startup context the launcher writes to the server's standard input. */
export type LaunchContext = { secret: string; repositories: LaunchRepository[] }

/** Why a repository has no usable Log source. A failure is reported; no other source is ever chosen instead. */
export type SourceFailureCode = 'invalid_config' | 'missing_read_credential' | 'logs_disabled'

export type LogSourceSpec =
  | { kind: 'folder'; folderRoot: string; repoDir: string }
  | {
      kind: 'server'
      url: string
      /** Raw `logs.readHeaders`, `${VAR}` references intact. Held for the follower; never sent to a browser. */
      readHeaders: Record<string, string> | undefined
    }

export type RepositorySource =
  | { ok: true; spec: LogSourceSpec }
  | { ok: false; code: SourceFailureCode; message: string }

export type StudioRepository = LaunchRepository & { source: RepositorySource }

/** What a browser may see of one repository: never a header, a value, or a credential name's value. */
export type RepositoryView = {
  root: string
  remote: string | null
  source: { ok: true; kind: 'folder' | 'server' } | { ok: false; code: SourceFailureCode; message: string }
}

function isRemote(value: unknown): value is RemoteIdentity | null {
  if (value === null) return true
  const v = value as { owner?: unknown; repo?: unknown }
  return typeof v === 'object' && typeof v.owner === 'string' && typeof v.repo === 'string'
}

/** Reads the launcher's startup context; throws a message naming what is wrong. */
export function parseLaunchContext(text: string): LaunchContext {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('the launch context is not JSON')
  }
  const value = raw as { secret?: unknown; repositories?: unknown }
  if (typeof value?.secret !== 'string' || !Array.isArray(value.repositories) || value.repositories.length === 0) {
    throw new Error('the launch context needs a secret and at least one repository')
  }
  const repositories = value.repositories.map((entry: unknown) => {
    const e = entry as { root?: unknown; remote?: unknown }
    if (
      typeof e?.root !== 'string' ||
      (!e.root.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(e.root)) ||
      !isRemote(e.remote)
    ) {
      throw new Error('the launch context has a malformed repository')
    }
    return { root: e.root, remote: e.remote ?? null }
  })
  return { secret: value.secret, repositories }
}

type ConfigRead =
  | { ok: true; config: ReturnType<typeof VinayaConfigSchema.parse> | null }
  | { ok: false; message: string }

/**
 * The repository's configuration, read from its own root with the checked rules: the repository file, else the
 * machine-wide file, else none. A missing file is `config: null`; an unreadable or invalid one is a failure, never a
 * silent default. It never reads the working directory, so concurrent repositories cannot disturb each other.
 */
function readConfig(root: string): ConfigRead {
  const local = join(root, LOCAL_CONFIG_FILENAME)
  const path = existsSync(local) ? local : existsSync(GLOBAL_CONFIG_PATH) ? GLOBAL_CONFIG_PATH : null
  if (path === null) return { ok: true, config: null }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    return { ok: false, message: `${path} is not readable JSON (${(err as Error).message.split('\n')[0]})` }
  }
  const parsed = VinayaConfigSchema.safeParse(raw)
  if (!parsed.success)
    return { ok: false, message: `${path} is not a valid configuration (${schemaIssueDetail(parsed.error)})` }
  return { ok: true, config: parsed.data }
}

export type ResolveDeps = { env?: Record<string, string | undefined>; home?: string }

/**
 * The folder one repository's streams live in under a log folder: `<owner>-<repo>`, or `unresolved` with no remote
 * identity — the layout the Log sink itself writes (`repoDirFor` in `log-sync-folder-source.ts`). The sink's own module
 * is not imported: its dependencies are the whole Log writer, which a read-only app has no use for.
 */
function repoFolderName(remote: RemoteIdentity | null): string {
  return remote ? `${remote.owner}-${remote.repo}` : 'unresolved'
}

function resolveSource(repository: LaunchRepository, deps: ResolveDeps): RepositorySource {
  const env = (deps.env ?? process.env) as NodeJS.ProcessEnv
  const read = readConfig(repository.root)
  if (!read.ok) return { ok: false, code: 'invalid_config', message: read.message }
  const config = read.config
  if (config?.logs === false) {
    return { ok: false, code: 'logs_disabled', message: 'this repository configures logs: false, so it records no Log' }
  }
  const logs = resolveLogsSetting(config)
  if (logs && 'url' in logs) {
    const readHeaders = config?.logs && typeof config.logs === 'object' ? config.logs.readHeaders : undefined
    if (credentialMissing(readHeaders, env)) {
      const names = credentialVarNames(readHeaders)
      return {
        ok: false,
        code: 'missing_read_credential',
        message: `the read credential is missing — set ${names.join(', ')} in the environment Studio is launched from (the value is never shown).`
      }
    }
    return { ok: true, spec: { kind: 'server', url: logs.url, readHeaders } }
  }
  const folderRoot =
    logs && 'folder' in logs
      ? logs.folder
      : join(
          resolveRuntimeDir({
            repo: repository.remote,
            localConfig: config,
            unattended: false,
            home: deps.home,
            repoRoot: repository.root
          }),
          'logs'
        )
  return {
    ok: true,
    spec: { kind: 'folder', folderRoot, repoDir: join(folderRoot, repoFolderName(repository.remote)) }
  }
}

/** Resolves every explicitly selected repository's Log source. Pure of the working directory and of the forge. */
export function resolveStudioRepositories(
  repositories: readonly LaunchRepository[],
  deps: ResolveDeps = {}
): StudioRepository[] {
  return repositories.map((repository) => ({ ...repository, source: resolveSource(repository, deps) }))
}

/** The browser-safe view of the resolved repositories. */
export function repositoryViews(repositories: readonly StudioRepository[]): RepositoryView[] {
  return repositories.map((r) => ({
    root: r.root,
    remote: r.remote ? `${r.remote.owner}/${r.remote.repo}` : null,
    source: r.source.ok
      ? { ok: true, kind: r.source.spec.kind }
      : { ok: false, code: r.source.code, message: r.source.message }
  }))
}

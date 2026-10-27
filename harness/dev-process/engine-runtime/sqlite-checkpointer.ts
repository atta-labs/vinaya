import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import enginePackage from '@atta/engine/package.json' with { type: 'json' }
import executorPackage from '@atta/executor-agent-spawn/package.json' with { type: 'json' }
import type { RunnableConfig } from '@langchain/core/runnables'
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple
} from '@langchain/langgraph'

// A checkpoint saver that keeps a run's checkpoints in one SQLite file, so a
// runner process started later on the same file resumes the run from its last
// completed step. Every checkpoint row records the code revision of the
// checkout that wrote it, the model the run was started with, the checkpoint
// format version and the Engine runtime version. A file or a row this saver
// cannot read is reported as `CheckpointCorruptError`, never as an ordinary
// failure.

/** The layout of a checkpoint row and its serialized state; raised when either changes in a way an older reader cannot read. */
export const CHECKPOINT_FORMAT_VERSION = 1

/** The packed Engine runtime that writes and resumes checkpoints: the Engine and its executor, each at its version. */
export const ENGINE_RUNTIME_VERSION = `${enginePackage.name}@${enginePackage.version} ${executorPackage.name}@${executorPackage.version}`

/** Channel carrying packets sent to nodes but not yet processed; the checkpoint omits them. */
const TASKS_CHANNEL = '__pregel_tasks'

/** The executor's channel of recorded step results. */
const RESULTS_CHANNEL = 'results'

/** Special writes take negative slots so they never collide with a step's regular writes. */
const SPECIAL_WRITE_SLOTS: Readonly<Record<string, number>> = {
  __error__: -1,
  __scheduled__: -2,
  __interrupt__: -3,
  __resume__: -4
}

export interface CheckpointProvenance {
  /** The code revision of the checkout that wrote the checkpoint. */
  revision: string
  /** The model the run was started with; empty when the run left the vendor's default. */
  model: string
  /** The checkpoint format version it was written in; null for a row written before the version was recorded. */
  formatVersion: number | null
  /** The Engine runtime version that wrote it; null for a row written before the version was recorded. */
  runtimeVersion: string | null
}

/** Why a runner refuses to resume a checkpoint. */
export type CheckpointRefusalCode =
  | 'checkpoint_corrupt'
  | 'checkpoint_version_unrecorded'
  | 'checkpoint_format_incompatible'
  | 'runtime_version_incompatible'

export interface CheckpointRefusal {
  code: CheckpointRefusalCode
  detail: string
}

/** A checkpoint file, or a row in it, that this saver cannot read. */
export class CheckpointCorruptError extends Error {
  readonly code = 'checkpoint_corrupt' as const
  constructor(
    readonly path: string,
    cause: unknown
  ) {
    super(`the checkpoint file ${path} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'CheckpointCorruptError'
  }
}

/** The versions a `name@version name@version` runtime string names, by package; null when the string is not one. */
function runtimePackages(runtime: string): Map<string, string> | null {
  const packages = new Map<string, string>()
  for (const part of runtime.split(' ')) {
    const at = part.lastIndexOf('@')
    if (at <= 0) return null
    packages.set(part.slice(0, at), part.slice(at + 1))
  }
  return packages.size > 0 ? packages : null
}

/** Whether `running` is in the caret range of `recorded`: the same major, or for 0.x the same minor, or for 0.0.x the same patch. */
function caretCompatible(recorded: string, running: string): boolean {
  const was = /^(\d+)\.(\d+)\.(\d+)/.exec(recorded)
  const now = /^(\d+)\.(\d+)\.(\d+)/.exec(running)
  if (was === null || now === null || was[1] !== now[1]) return false
  if (was[1] !== '0') return true
  if (was[2] !== now[2]) return false
  return was[2] !== '0' || was[3] === now[3]
}

/**
 * Why a runner at `running` refuses to resume a checkpoint recorded under `recorded`, or null when it resumes it. A
 * moved code revision or model never refuses: only a checkpoint that records neither version, is in another format, or
 * was written by an Engine runtime outside the running one's caret range.
 */
export function checkpointRefusal(
  recorded: Pick<CheckpointProvenance, 'formatVersion' | 'runtimeVersion'>,
  running: { formatVersion: number; runtimeVersion: string } = {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    runtimeVersion: ENGINE_RUNTIME_VERSION
  }
): CheckpointRefusal | null {
  if (recorded.formatVersion === null && recorded.runtimeVersion === null) {
    return {
      code: 'checkpoint_version_unrecorded',
      detail: `the checkpoint records neither its format version nor the Engine runtime that wrote it; this runner reads format ${running.formatVersion} under ${running.runtimeVersion}`
    }
  }
  if (recorded.formatVersion !== running.formatVersion) {
    return {
      code: 'checkpoint_format_incompatible',
      detail: `the checkpoint is in format ${recorded.formatVersion ?? 'unrecorded'}; this runner reads format ${running.formatVersion}`
    }
  }
  const was = recorded.runtimeVersion === null ? null : runtimePackages(recorded.runtimeVersion)
  const now = runtimePackages(running.runtimeVersion)
  const compatible =
    was !== null &&
    now !== null &&
    was.size === now.size &&
    [...now].every(([name, version]) => {
      const prior = was.get(name)
      return prior !== undefined && caretCompatible(prior, version)
    })
  if (!compatible) {
    return {
      code: 'runtime_version_incompatible',
      detail: `the checkpoint was written by ${recorded.runtimeVersion ?? 'an unrecorded Engine runtime'}; this runner is ${running.runtimeVersion}`
    }
  }
  return null
}

export interface SqliteCheckpointerOptions {
  /** The SQLite file; its folder is created when missing. */
  path: string
  /** The code revision recorded on every checkpoint this saver writes. */
  revision: string
  /** The model recorded on every checkpoint this saver writes. */
  model?: string
  /** The format version recorded on every checkpoint; the current one unless a test writes another. */
  formatVersion?: number
  /** The Engine runtime version recorded on every checkpoint; the running one unless a test writes another. */
  runtimeVersion?: string
  /** The agent the run was started with, recorded on every checkpoint; unrecorded (null) when absent. */
  agent?: string
  /** The flow bound to every checkpoint of this generation. */
  flow?: string
  /**
   * Called after each database write has committed, with what it committed. A throw is a failed required write: the
   * saver keeps it and `assertPersisted` raises it, so the run pauses before its next step without undoing the commit.
   */
  onCommit?: (commit: CheckpointCommit) => void
}

/** One committed database write: a full checkpoint, or the pending writes of a completed step. */
export interface CheckpointCommit {
  threadId: string
  checkpointNs: string
  /** The checkpoint the write is stored under; for pending writes, the last full checkpoint they apply to. */
  checkpointId: string
  kind: 'checkpoint' | 'writes'
  /** The step results the write carries: a full checkpoint's whole `results` channel, or one step's own result. */
  results: Readonly<Record<string, unknown>>
}

/** The results a thread continues from: its latest full checkpoint's `results` with its pending writes applied. */
export interface EffectiveResults {
  checkpointId: string
  results: Record<string, unknown>
}

/** A required write that followed a committed checkpoint write failed: the run must not progress past it. */
export class CheckpointCommitFollowUpError extends Error {
  constructor(cause: unknown) {
    super(
      `a required write after a committed checkpoint failed, so the run pauses before its next step: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
    this.name = 'CheckpointCommitFollowUpError'
  }
}

interface CheckpointRow {
  thread_id: string
  checkpoint_ns: string
  checkpoint_id: string
  parent_id: string | null
  type: string
  checkpoint: Uint8Array
  metadata: Uint8Array
  revision: string
  model: string
  format_version: number | null
  runtime_version: string | null
  agent: string | null
}

interface WriteRow {
  task_id: string
  channel: string
  type: string
  value: Uint8Array
}

type ProvenanceRow = Pick<CheckpointRow, 'revision' | 'model' | 'format_version' | 'runtime_version'>
const PROVENANCE_COLUMNS = 'revision, model, format_version, runtime_version'
const provenanceOfRow = (row: ProvenanceRow): CheckpointProvenance => ({
  revision: row.revision,
  model: row.model,
  formatVersion: row.format_version,
  runtimeVersion: row.runtime_version
})

export class SqliteCheckpointer extends BaseCheckpointSaver {
  private readonly db: Database
  private readonly path: string
  private readonly revision: string
  private readonly model: string
  private readonly formatVersion: number
  private readonly runtimeVersion: string
  private readonly agent: string | null
  private readonly flow: string | null
  private readonly onCommit: ((commit: CheckpointCommit) => void) | undefined
  private commitFailure: CheckpointCommitFollowUpError | null = null

  /** Opens or creates the file; throws `CheckpointCorruptError` when it is not a checkpoint file this saver can read. */
  constructor(options: SqliteCheckpointerOptions) {
    super()
    mkdirSync(dirname(options.path), { recursive: true })
    this.path = options.path
    this.revision = options.revision
    this.model = options.model ?? ''
    this.formatVersion = options.formatVersion ?? CHECKPOINT_FORMAT_VERSION
    this.runtimeVersion = options.runtimeVersion ?? ENGINE_RUNTIME_VERSION
    this.agent = options.agent ?? null
    this.flow = options.flow ?? null
    this.onCommit = options.onCommit
    try {
      this.db = new Database(options.path, { create: true })
    } catch (error) {
      throw new CheckpointCorruptError(options.path, error)
    }
    try {
      this.createTables()
    } catch (error) {
      this.db.close()
      throw new CheckpointCorruptError(options.path, error)
    }
  }

  private createTables(): void {
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        parent_id TEXT,
        type TEXT NOT NULL,
        checkpoint BLOB NOT NULL,
        metadata BLOB NOT NULL,
        revision TEXT NOT NULL,
        model TEXT NOT NULL,
        format_version INTEGER,
        runtime_version TEXT,
        agent TEXT,
        flow TEXT,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT NOT NULL,
        value BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
    `)
    // A file written before the versions were recorded gains their columns; its own rows record neither.
    const columns = new Set(
      this.db
        .query<{ name: string }, []>('PRAGMA table_info(checkpoints)')
        .all()
        .map((column) => column.name)
    )
    if (!columns.has('format_version')) this.db.exec('ALTER TABLE checkpoints ADD COLUMN format_version INTEGER')
    if (!columns.has('runtime_version')) this.db.exec('ALTER TABLE checkpoints ADD COLUMN runtime_version TEXT')
    if (!columns.has('agent')) this.db.exec('ALTER TABLE checkpoints ADD COLUMN agent TEXT')
    if (!columns.has('flow')) this.db.exec('ALTER TABLE checkpoints ADD COLUMN flow TEXT')
  }

  /** Closes the file; the saver is unusable afterwards. */
  close(): void {
    this.db.close()
  }

  /** The revision, model and versions of the thread's latest checkpoint, or undefined when it has none. */
  latestProvenance(threadId: string, checkpointNs = ''): CheckpointProvenance | undefined {
    const row = this.read(() =>
      this.db
        .query<ProvenanceRow, [string, string]>(
          `SELECT ${PROVENANCE_COLUMNS} FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?
           ORDER BY checkpoint_id DESC LIMIT 1`
        )
        .get(threadId, checkpointNs)
    )
    return row ? provenanceOfRow(row) : undefined
  }

  /** The revision, model and versions recorded on one checkpoint. */
  provenanceOf(threadId: string, checkpointId: string, checkpointNs = ''): CheckpointProvenance | undefined {
    const row = this.read(() =>
      this.db
        .query<ProvenanceRow, [string, string, string]>(
          `SELECT ${PROVENANCE_COLUMNS} FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
        )
        .get(threadId, checkpointNs, checkpointId)
    )
    return row ? provenanceOfRow(row) : undefined
  }

  /** The agent recorded on the thread's latest checkpoint: null when unrecorded, undefined when it has no checkpoint. */
  latestAgent(threadId: string, checkpointNs = ''): string | null | undefined {
    const row = this.read(() =>
      this.db
        .query<{ agent: string | null }, [string, string]>(
          `SELECT agent FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?
           ORDER BY checkpoint_id DESC LIMIT 1`
        )
        .get(threadId, checkpointNs)
    )
    return row ? row.agent : undefined
  }

  /**
   * The `results` a resume of the thread continues from: the latest full checkpoint's, with the pending writes of
   * the steps that completed after it applied, as the executor applies them on resume. Undefined when the thread has
   * no checkpoint.
   */
  async effectiveResults(threadId: string, checkpointNs = ''): Promise<EffectiveResults | undefined> {
    const tuple = await this.getTuple({ configurable: { thread_id: threadId, checkpoint_ns: checkpointNs } })
    if (tuple === undefined) return undefined
    const stored = (tuple.checkpoint.channel_values as Record<string, unknown>).results
    const results: Record<string, unknown> = { ...((stored as Record<string, unknown> | undefined) ?? {}) }
    for (const [, channel, value] of tuple.pendingWrites ?? []) {
      if (channel === RESULTS_CHANNEL && value !== null && typeof value === 'object') Object.assign(results, value)
    }
    return { checkpointId: tuple.checkpoint.id, results }
  }

  /**
   * Raises the failure of a required write that followed a committed checkpoint write, once every save the executor
   * has scheduled so far has run. A run calls it before each step, so nothing dependent starts past a failed write.
   */
  async assertPersisted(): Promise<void> {
    await new Promise((settle) => setImmediate(settle))
    if (this.commitFailure !== null) throw this.commitFailure
  }

  /**
   * Hands a committed write to `onCommit`. A throw is kept for `assertPersisted` rather than raised here: the commit
   * stands, the executor's later saves still run in order, and the run stops at its next step's barrier.
   */
  private committed(commit: CheckpointCommit): void {
    if (this.onCommit === undefined || this.commitFailure !== null) return
    try {
      this.onCommit(commit)
    } catch (error) {
      this.commitFailure = new CheckpointCommitFollowUpError(error)
    }
  }

  /** One read of the file; a file it cannot read is reported as corrupt. */
  private read<T>(query: () => T): T {
    try {
      return query()
    } catch (error) {
      throw new CheckpointCorruptError(this.path, error)
    }
  }

  private writesOf(threadId: string, ns: string, checkpointId: string): WriteRow[] {
    return this.read(() =>
      this.db
        .query<WriteRow, [string, string, string]>(
          `SELECT task_id, channel, type, value FROM writes
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY task_id, idx`
        )
        .all(threadId, ns, checkpointId)
    )
  }

  /** The tuple a row holds; a row whose state cannot be read back is corrupt. */
  private async tupleOf(row: CheckpointRow): Promise<CheckpointTuple> {
    try {
      return await this.readTuple(row)
    } catch (error) {
      throw error instanceof CheckpointCorruptError ? error : new CheckpointCorruptError(this.path, error)
    }
  }

  private async readTuple(row: CheckpointRow): Promise<CheckpointTuple> {
    const { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpointId } = row
    const pendingSends = row.parent_id
      ? await Promise.all(
          this.writesOf(threadId, ns, row.parent_id)
            .filter((write) => write.channel === TASKS_CHANNEL)
            .map((write) => this.serde.loadsTyped(write.type, write.value))
        )
      : []
    const checkpoint = {
      ...((await this.serde.loadsTyped(row.type, row.checkpoint)) as Checkpoint),
      pending_sends: pendingSends
    } as Checkpoint
    const pendingWrites = await Promise.all(
      this.writesOf(threadId, ns, checkpointId).map(
        async (write) =>
          [write.task_id, write.channel, await this.serde.loadsTyped(write.type, write.value)] as [
            string,
            string,
            unknown
          ]
      )
    )
    return {
      config: { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpointId } },
      checkpoint,
      metadata: (await this.serde.loadsTyped(row.type, row.metadata)) as CheckpointMetadata,
      pendingWrites,
      ...(row.parent_id
        ? { parentConfig: { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: row.parent_id } } }
        : {})
    }
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (threadId === undefined) return undefined
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ''
    const checkpointId = (config.configurable?.checkpoint_id ?? config.configurable?.thread_ts) as string | undefined
    const row = this.read(() =>
      checkpointId
        ? this.db
            .query<CheckpointRow, [string, string, string]>(
              'SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?'
            )
            .get(threadId, ns, checkpointId)
        : this.db
            .query<CheckpointRow, [string, string]>(
              `SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?
               ORDER BY checkpoint_id DESC LIMIT 1`
            )
            .get(threadId, ns)
    )
    return row ? this.tupleOf(row) : undefined
  }

  async *list(
    config: RunnableConfig,
    options?: { limit?: number; before?: RunnableConfig; filter?: Record<string, unknown> }
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string | undefined
    const ns = config.configurable?.checkpoint_ns as string | undefined
    const checkpointId = config.configurable?.checkpoint_id as string | undefined
    const before = options?.before?.configurable?.checkpoint_id as string | undefined
    const clauses: string[] = []
    const params: string[] = []
    if (threadId !== undefined) {
      clauses.push('thread_id = ?')
      params.push(threadId)
    }
    if (ns !== undefined) {
      clauses.push('checkpoint_ns = ?')
      params.push(ns)
    }
    if (checkpointId) {
      clauses.push('checkpoint_id = ?')
      params.push(checkpointId)
    }
    if (before) {
      clauses.push('checkpoint_id < ?')
      params.push(before)
    }
    const rows = this.read(() =>
      this.db
        .query<CheckpointRow, string[]>(
          `SELECT * FROM checkpoints ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
           ORDER BY checkpoint_id DESC`
        )
        .all(...params)
    )
    let remaining = options?.limit
    for (const row of rows) {
      let metadata: Record<string, unknown>
      try {
        metadata = (await this.serde.loadsTyped(row.type, row.metadata)) as Record<string, unknown>
      } catch (error) {
        throw new CheckpointCorruptError(this.path, error)
      }
      if (options?.filter && !Object.entries(options.filter).every(([key, value]) => metadata[key] === value)) continue
      if (remaining !== undefined) {
        if (remaining <= 0) break
        remaining -= 1
      }
      yield await this.tupleOf(row)
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined
    if (threadId === undefined)
      throw new Error('Failed to put checkpoint: the config has no "thread_id" in its "configurable" property')
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ''
    const prepared = copyCheckpoint(checkpoint) as Partial<Checkpoint>
    delete prepared.pending_sends
    const [type, serialized] = this.serde.dumpsTyped(prepared)
    const [, serializedMetadata] = this.serde.dumpsTyped(metadata)
    this.db
      .query(
        `INSERT OR REPLACE INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_id, type, checkpoint, metadata, revision, model,
          format_version, runtime_version, agent, flow)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        threadId,
        ns,
        checkpoint.id,
        (config.configurable?.checkpoint_id as string | undefined) ?? null,
        type,
        serialized,
        serializedMetadata,
        this.revision,
        this.model,
        this.formatVersion,
        this.runtimeVersion,
        this.agent,
        this.flow
      )
    const results = (checkpoint.channel_values as Record<string, unknown>)[RESULTS_CHANNEL]
    this.committed({
      threadId,
      checkpointNs: ns,
      checkpointId: checkpoint.id,
      kind: 'checkpoint',
      results: (results as Record<string, unknown> | undefined) ?? {}
    })
    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id } }
  }

  async putWrites(config: RunnableConfig, writes: Array<[string, unknown]>, taskId: string): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined
    const checkpointId = config.configurable?.checkpoint_id as string | undefined
    if (threadId === undefined)
      throw new Error('Failed to put writes: the config has no "thread_id" in its "configurable" property')
    if (checkpointId === undefined)
      throw new Error('Failed to put writes: the config has no "checkpoint_id" in its "configurable" property')
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? ''
    // A regular write already stored for its slot is kept; a special write replaces its own.
    const insert = this.db.query(
      `INSERT OR IGNORE INTO writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const replace = this.db.query(
      `INSERT OR REPLACE INTO writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.db.transaction(() => {
      writes.forEach(([channel, value], index) => {
        const [type, serialized] = this.serde.dumpsTyped(value)
        const special = SPECIAL_WRITE_SLOTS[channel]
        const statement = special === undefined ? insert : replace
        statement.run(threadId, ns, checkpointId, taskId, special ?? index, channel, type, serialized)
      })
    })()
    const results: Record<string, unknown> = {}
    for (const [channel, value] of writes) {
      if (channel === RESULTS_CHANNEL && value !== null && typeof value === 'object') Object.assign(results, value)
    }
    if (Object.keys(results).length > 0)
      this.committed({ threadId, checkpointNs: ns, checkpointId, kind: 'writes', results })
  }
}

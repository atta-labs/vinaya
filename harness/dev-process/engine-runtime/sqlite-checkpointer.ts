import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
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
// checkout that wrote it and the model the run was started with.

/** Channel carrying packets sent to nodes but not yet processed; the checkpoint omits them. */
const TASKS_CHANNEL = '__pregel_tasks'

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
}

export interface SqliteCheckpointerOptions {
  /** The SQLite file; its folder is created when missing. */
  path: string
  /** The code revision recorded on every checkpoint this saver writes. */
  revision: string
  /** The model recorded on every checkpoint this saver writes. */
  model?: string
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
}

interface WriteRow {
  task_id: string
  channel: string
  type: string
  value: Uint8Array
}

export class SqliteCheckpointer extends BaseCheckpointSaver {
  private readonly db: Database
  private readonly revision: string
  private readonly model: string

  constructor(options: SqliteCheckpointerOptions) {
    super()
    mkdirSync(dirname(options.path), { recursive: true })
    this.db = new Database(options.path, { create: true })
    this.revision = options.revision
    this.model = options.model ?? ''
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
  }

  /** Closes the file; the saver is unusable afterwards. */
  close(): void {
    this.db.close()
  }

  /** The revision and model of the thread's latest checkpoint, or undefined when it has none. */
  latestProvenance(threadId: string, checkpointNs = ''): CheckpointProvenance | undefined {
    const row = this.db
      .query<{ revision: string; model: string }, [string, string]>(
        `SELECT revision, model FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?
         ORDER BY checkpoint_id DESC LIMIT 1`
      )
      .get(threadId, checkpointNs)
    return row ? { revision: row.revision, model: row.model } : undefined
  }

  /** The revision and model recorded on one checkpoint. */
  provenanceOf(threadId: string, checkpointId: string, checkpointNs = ''): CheckpointProvenance | undefined {
    const row = this.db
      .query<{ revision: string; model: string }, [string, string, string]>(
        'SELECT revision, model FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?'
      )
      .get(threadId, checkpointNs, checkpointId)
    return row ? { revision: row.revision, model: row.model } : undefined
  }

  private writesOf(threadId: string, ns: string, checkpointId: string): WriteRow[] {
    return this.db
      .query<WriteRow, [string, string, string]>(
        `SELECT task_id, channel, type, value FROM writes
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY task_id, idx`
      )
      .all(threadId, ns, checkpointId)
  }

  private async tupleOf(row: CheckpointRow): Promise<CheckpointTuple> {
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
    const row = checkpointId
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
    const rows = this.db
      .query<CheckpointRow, string[]>(
        `SELECT * FROM checkpoints ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY checkpoint_id DESC`
      )
      .all(...params)
    let remaining = options?.limit
    for (const row of rows) {
      const metadata = (await this.serde.loadsTyped(row.type, row.metadata)) as Record<string, unknown>
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
         (thread_id, checkpoint_ns, checkpoint_id, parent_id, type, checkpoint, metadata, revision, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        this.model
      )
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
  }
}

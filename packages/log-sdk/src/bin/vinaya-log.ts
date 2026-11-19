#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkCustomEvent } from '../contract/custom.js'
import { connect } from '../writer/connect.js'
import { resolveSettings } from '../writer/settings.js'
import { EMIT_USAGE, readFields, takeOption } from './args.js'
import { commands, invoke, MissingStart } from './commands.js'
import { follow, localFolder } from './follow.js'

function git(...args: string[]): string | undefined {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function repositoryName(): string | undefined {
  const url = git('remote', 'get-url', 'origin')?.replace(/\.git$/, '')
  return process.env.VINAYA_REPO || url?.match(/(?:\/\/[^/]+\/|^[^/]+:)([^/]+\/[^/]+)$/)?.[1]
}

async function stdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

function usage(command?: string, message?: string): number {
  if (message !== undefined) console.error('vinaya log emit: %s', message)
  if (command === 'emit') {
    process.stderr.write(EMIT_USAGE)
  } else {
    console.error("Usage: vinaya-log <command> --run <id> --json '<json object>' (or use standard input)")
    console.error('       vinaya-log follow [--run <id> | --task <ref>]')
    console.error('Commands: %s', [...commands.keys()].join(', '))
  }
  return 2
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv]
  const runId = takeOption(args, '--run')
  const task = takeOption(args, '--task')
  const subject = args.shift()
  const command = subject === 'emit' || subject === 'follow' ? subject : subject + ' ' + args.shift()
  if (runId === null || task === null) return usage(command)
  if (
    runId !== undefined &&
    (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(runId) || runId.includes('..') || runId.length > 190)
  ) {
    return usage(command)
  }
  const repoRoot = git('rev-parse', '--show-toplevel') ?? process.cwd()
  const repository = repositoryName()
  const location = { repoRoot, ...(repository === undefined ? {} : { repository }) }

  if (command === 'follow') {
    if (args.length > 0 || (runId !== undefined && task !== undefined)) return usage(command)
    const resolved = resolveSettings(location)
    if (!resolved.ok) return 1
    await follow(await localFolder(resolved.settings, repoRoot, repository), {
      ...(runId === undefined ? {} : { run: runId }),
      ...(task === undefined ? {} : { task })
    })
    return 0
  }

  if (!commands.has(command) || runId === undefined) return usage(command)
  const parsed = await readFields(command === 'emit' ? args : [command, ...args], stdin)
  if (!parsed.ok) return usage(command, parsed.message)

  const resolved = resolveSettings(location)
  if (!resolved.ok) {
    console.error('vinaya-log: invalid Log settings')
    return 1
  }
  const { settings, declarations } = resolved
  const checked = command === 'emit' ? checkCustomEvent(declarations, parsed.name, parsed.fields) : undefined
  if (checked !== undefined && !checked.ok) {
    const fields = checked.fieldNames.length === 0 ? '' : ' (fields: ' + checked.fieldNames.join(', ') + ')'
    console.error('vinaya log emit: refused — %s%s', checked.reason, fields)
    return 1
  }

  let failed = false
  const workRef = task ?? (process.env.VINAYA_WORK_REF || undefined)
  const handle = connect({
    ...location,
    runId,
    ...(workRef === undefined ? {} : { workRef }),
    onError: () => {
      failed = true
    }
  })
  try {
    const folder = await localFolder(settings, repoRoot, repository)
    if (checked?.ok) {
      handle.custom.recorded(checked.name, checked.fields)
    } else {
      await invoke(command, handle, parsed.fields, folder)
    }
  } catch (error) {
    console.error(error instanceof MissingStart ? error.message : 'vinaya-log: command failed')
    return 1
  } finally {
    await handle.shutdown()
  }
  if (failed) {
    console.error('vinaya-log: could not record')
    return 1
  }
  if (checked?.ok) console.log('vinaya log emit: recorded %s → %s', checked.name, handle.enabled ? 'folder' : 'none')
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch {
    console.error('vinaya-log: command failed')
    process.exitCode = 1
  }
}

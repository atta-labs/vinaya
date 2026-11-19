import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFolderSource } from '../src/reader/folder-source.js'

const entry = fileURLToPath(new URL('../src/bin/vinaya-log.ts', import.meta.url))

export function fixture(logs: object = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'vinaya-log-bin-'))
  const cwd = join(temp, 'repo')
  const runtimeDir = join(temp, 'runtime')
  const folder = join(runtimeDir, 'logs', 'unresolved')
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'log.config.json'), JSON.stringify({ runtimeDir, logs }))
  const env = { ...process.env, VINAYA_REPO: '', VINAYA_WORK_REF: '' }
  return {
    cwd,
    folder,
    call: (args: string[], stdin?: string) =>
      Bun.spawnSync([process.execPath, entry, ...args], {
        cwd,
        env,
        ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) })
      }),
    follow: (args: string[]) =>
      Bun.spawn([process.execPath, entry, 'follow', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' }),
    read: (runId = 'test-run') => createFolderSource({ runId, folder }).read(),
    clean: () => rmSync(temp, { recursive: true, force: true })
  }
}

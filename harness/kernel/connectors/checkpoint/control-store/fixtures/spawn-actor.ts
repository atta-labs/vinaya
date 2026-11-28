// Starts `control-store-actor-worker.ts` as its own OS process and exposes
// its JSON stdout lines: `next()` resolves with the next line printed, and
// `done` with every line once the process exits cleanly (or is killed).

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const workerPath = join(import.meta.dir, 'control-store-actor-worker.ts')

export type Actor = {
  readonly child: ChildProcess
  next(): Promise<unknown>
  readonly done: Promise<unknown[]>
}

/** Resolves once `path` exists, polling; rejects when `actor` exits first. */
export async function waitForFile(path: string, actor: Actor): Promise<void> {
  let exited = false
  actor.done.then(
    () => {
      exited = true
    },
    () => {
      exited = true
    }
  )
  while (!existsSync(path)) {
    if (exited) throw new Error(`the actor exited before ${path} existed`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export function startActor(mode: string, rootDir: string, task: number, ...args: string[]): Actor {
  const child = spawn('bun', [workerPath, mode, rootDir, String(task), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  const lines: unknown[] = []
  const waiters: Array<(line: unknown) => void> = []
  let read = 0
  let buffer = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = JSON.parse(buffer.slice(0, at)) as unknown
      buffer = buffer.slice(at + 1)
      lines.push(line)
      const waiter = waiters.shift()
      if (waiter) {
        read++
        waiter(line)
      }
    }
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  const done = new Promise<unknown[]>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code !== 0 && signal === null) reject(new Error(`actor ${mode} exited ${code}: ${stderr}`))
      else resolve(lines)
    })
  })
  return {
    child,
    next: () =>
      read < lines.length
        ? Promise.resolve(lines[read++])
        : Promise.race([
            new Promise<unknown>((resolve) => waiters.push(resolve)),
            done.then(() => {
              throw new Error(`actor ${mode} exited before printing another line: ${stderr}`)
            })
          ]),
    done
  }
}

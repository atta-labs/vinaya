/**
 * The Vinaya rule for the doctrine version a Log header records
 * (`meta.doctrine`), supplied to the kernel Log sink as its
 * `doctrineIdentity` dependency by `createVinayaLogSink`.
 *
 * - When the repository's toplevel holds the doctrine's front door at its
 *   source path, the version is `doctrine@<id>`: `<id>` is
 *   `git hash-object --stdin` over the output of
 *   `git -C <toplevel> ls-tree HEAD -- <every doctrine map source path>`, so
 *   it changes when any doctrine file changes and never when other process
 *   code changes.
 * - Otherwise it is the package version.
 * - When `git` itself cannot be reached, it is `unknown`.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DOCTRINE_REPO_PATHS, DOCTRINE_TREE, FRONT_DOOR_SOURCE } from '../../tools/doctrine/doctrine-map'

const execFileAsync = promisify(execFile)

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** `git hash-object --stdin` over `input`; rejects when git exits non-zero. */
function hashObject(cwd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, 'hash-object', '--stdin'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`git hash-object exited ${code}`))
    )
    child.stdin.end(input)
  })
}

/** The doctrine version for a sink whose working directory is `cwd`. Never throws. */
export async function vinayaDoctrineIdentity(cwd: string, packageVersion: string): Promise<string> {
  let toplevel: string
  try {
    toplevel = (
      await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
    ).stdout.trim()
  } catch (err) {
    return isEnoent(err) ? 'unknown' : packageVersion
  }
  if (!existsSync(join(toplevel, DOCTRINE_TREE, FRONT_DOOR_SOURCE))) return packageVersion
  try {
    const listing = (
      await execFileAsync('git', ['-C', toplevel, 'ls-tree', 'HEAD', '--', ...DOCTRINE_REPO_PATHS], {
        encoding: 'utf8',
        maxBuffer: 1 << 20
      })
    ).stdout
    return `doctrine@${await hashObject(toplevel, listing)}`
  } catch {
    return packageVersion
  }
}

import { createStudioHost } from './host.ts'
import { type LaunchContext, parseLaunchContext, resolveStudioRepositories } from './repositories.ts'
import { isWellFormedSecret } from './session.ts'

/**
 * The normal way Studio starts: `entry --dir <next project> [--dev] --context-stdin`, listening on the loopback address
 * named by `HOSTNAME` and the port named by `PORT`. The CLI sets both; Studio never listens anywhere else. The launch
 * context (the one-time secret and the selected repositories) arrives as one JSON document on standard input, never in
 * an argument, an environment variable or a URL, so no process listing or page can read it.
 */

const FORCE_EXIT_MS = 5_000

function flag(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function readContext(): Promise<LaunchContext> {
  if (!process.argv.includes('--context-stdin')) {
    fail('Studio starts from `vinaya studio`, which hands it a one-time launch context.')
  }
  let text = ''
  for await (const chunk of process.stdin) text += String(chunk)
  const context = parseLaunchContext(text)
  if (!isWellFormedSecret(context.secret)) throw new Error('the launch context carries a malformed secret')
  return context
}

const dir = flag('--dir') ?? process.cwd()
const dev = process.argv.includes('--dev')
const hostname = process.env.HOSTNAME ?? '127.0.0.1'
const port = Number(process.env.PORT ?? '3008')

if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
  fail(`Studio listens only on the loopback address, not "${hostname}".`)
}

const context = await readContext().catch((error: unknown) =>
  fail(`Studio could not read its launch context: ${error instanceof Error ? error.message : String(error)}`)
)
const repositories = resolveStudioRepositories(context.repositories)
for (const repository of repositories) {
  if (!repository.source.ok) console.error(`Studio: ${repository.root}: ${repository.source.message}`)
}

const host = createStudioHost({ dir, dev, hostname, port, repositories, session: { secret: context.secret } })

let stopping = false
function stop(): void {
  if (stopping) return
  stopping = true
  const force = setTimeout(() => process.exit(1), FORCE_EXIT_MS)
  force.unref()
  host.close().then(
    () => process.exit(0),
    () => process.exit(1)
  )
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

host.listen().then(
  (bound) => console.log(`> Studio listening on http://${hostname}:${bound}${dev ? ' (development)' : ''}`),
  (error: unknown) => {
    console.error(`Studio could not start: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
)

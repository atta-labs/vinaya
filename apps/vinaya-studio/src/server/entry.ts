import { createStudioHost } from './host.ts'

/**
 * The normal way Studio starts: `entry --dir <next project> [--dev]`, listening on the loopback address named by
 * `HOSTNAME` and the port named by `PORT`. The CLI sets both; Studio never listens anywhere else.
 */

const FORCE_EXIT_MS = 5_000

function flag(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

const dir = flag('--dir') ?? process.cwd()
const dev = process.argv.includes('--dev')
const hostname = process.env.HOSTNAME ?? '127.0.0.1'
const port = Number(process.env.PORT ?? '3008')

if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
  console.error(`Studio listens only on the loopback address, not "${hostname}".`)
  process.exit(1)
}

const host = createStudioHost({ dir, dev, hostname, port })

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

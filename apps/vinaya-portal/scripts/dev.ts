import { spawn } from 'node:child_process'
import net from 'node:net'

// The portal owns 3007/3107, distinct from the studio's 3008/3108. Two apps that
// render the same product under the same theme look alike, so a shared port pair
// would let whichever boots second land on the other's fallback unnoticed.
const PRIMARY_PORT = 3007
const FALLBACK_PORT = 3107

/** Tries to bind `port` on all interfaces: free if the bind succeeds, taken if it errors. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => tester.close(() => resolve(true)))
    tester.listen(port, '0.0.0.0')
  })
}

const port = (await isPortFree(PRIMARY_PORT)) ? PRIMARY_PORT : FALLBACK_PORT
console.log(
  port === PRIMARY_PORT
    ? `[dev] starting on port ${port}`
    : `[dev] port ${PRIMARY_PORT} is taken, falling back to ${port}`
)

const child = spawn('next', ['dev', '--port', String(port)], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))

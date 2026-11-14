// Starts a worker thread: its modules load their own `fs`, out of the probe's wrap, so the process is wholly scanned.
import { Worker } from 'node:worker_threads'

const worker = new Worker('postMessage(6 * 7)', { eval: true })
const answer = await new Promise((resolve) => worker.once('message', resolve))
await worker.terminate()
console.log(JSON.stringify({ answer }))

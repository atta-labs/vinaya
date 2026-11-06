// Reproduces the wrong-event-loop finalizer path in oven-sh/bun#44581 and #47257.
// Pipe stderr and use BUN_JSC_slowPathAllocsBetweenGCs=3 in the parent.
globalThis.writers = []
const refs = []
for (let i = 0; i < 3; i++) {
  const writer = Bun.stderr.writer()
  writer.write('')
  writer.flush()
  globalThis.writers.push(writer)
  refs.push(new WeakRef(writer))
}
await Bun.sleep(0)
Bun.spawnSync({
  cmd: ['true'],
  stdout: 'pipe',
  stderr: 'ignore',
  get maxBuffer() {
    Bun.gc(true)
    globalThis.writers = null
  }
})
const collected = refs.filter((ref) => ref.deref() === undefined).length
const result = Bun.spawnSync({
  cmd: ['sh', '-c', 'sleep 0.1; echo polled'],
  stdout: 'pipe',
  stderr: 'pipe',
  timeout: 2000
})
console.log(JSON.stringify({ collected, output: result.stdout.toString(), timedOut: result.exitedDueToTimeout, status: result.exitCode }))

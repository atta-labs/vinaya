// Plain Node script (no TypeScript, no repo imports) so it can be spawned
// as a genuinely separate OS process from a test — real concurrency, not a
// sequential in-process simulation of one. It performs exactly the
// write-then-link sequence `exclusiveCreateFile` (packages/aeg-core/src/
// control-store/local.ts) uses to publish a file exclusively: write and
// `fsync` full content to a private temp file first, then `linkSync` it
// into the contested final path, which either fully succeeds or fails
// `EEXIST` with no partially-written state ever visible at that path.
//
// Argv: <targetPath> <content> <ownerId>. Prints one JSON line to stdout:
// `{ "outcome": "won" | "lost", "ownerId": <ownerId> }`.

import { closeSync, constants, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

const [, , targetPath, content, ownerId] = process.argv

mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
const tmp = `${targetPath}.claim-${process.pid}-${Math.random().toString(36).slice(2)}`
const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
try {
  writeSync(fd, content, null, 'utf8')
  fsyncSync(fd)
} finally {
  closeSync(fd)
}

let outcome
try {
  linkSync(tmp, targetPath)
  outcome = 'won'
} catch (err) {
  if (err.code !== 'EEXIST') throw err
  outcome = 'lost'
} finally {
  try {
    unlinkSync(tmp)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

process.stdout.write(`${JSON.stringify({ outcome, ownerId })}\n`)

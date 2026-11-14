#!/usr/bin/env node
/**
 * The `test-selection-record` command: on Linux with `strace`, runs each test file of the repository's inventory
 * (built from its workspace manifests, as the `test-selection` command builds it) in its own traced process with the
 * listing probe preloaded, and writes the read record the selection consumes (`recordCommand` in `recorder.ts`).
 * Never imported by the entrypoint.
 *
 * Usage:
 *   test-selection-record --out <dir> [--commit <sha>] [--concurrency <n>] [--shard <i>/<n>] [--only <test,test>] [--expect <test>=<path>] [--summary <file>]
 *   test-selection-record --merge <dir> --out <dir> [--commit <sha>] [--summary <file>]
 */
import { recordCommand } from './recorder.js'

process.exitCode = await recordCommand(process.argv.slice(2), { name: 'test-selection-record' })

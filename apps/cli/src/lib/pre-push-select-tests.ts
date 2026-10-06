#!/usr/bin/env node
/**
 * The pre-push hook's own entrypoint into the test
 * selector. Standalone (not routed through `index.ts`/`commands/`) so it
 * bundles and ships exactly like `checks/bin/*.ts` does, and so the hook can
 * invoke it directly without paying for the whole CLI's argv-parsing layer.
 *
 * Contract with the generated hook (`artifacts.ts`'s `prePushBody`): prints
 * one absolute test-file path per line to STDOUT (empty output means
 * nothing was selected — a valid, common outcome, not an error), and the
 * human-facing "selected N of M" line to STDERR, so the hook's own
 * `$(...)` capture of STDOUT is never polluted by it.
 *
 * `--escape-report <junit.xml> --tests-cwd <dir> [--base <ref>]` is CI's mode:
 * for each test file the JUnit report records as failing, it prints whether
 * this same selection would have run it for the diff from `--base`. It only
 * reports — it exits 0 whatever it finds, and on any error of its own, so it
 * never fails a job by itself.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { escapeReportLines, failingTestFilesFromJunit, prePushSelection } from './pre-push-selection.js'

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function escapeReport(repoRoot: string, argv: readonly string[]): void {
  try {
    const junit = flag(argv, '--escape-report') as string
    const testsCwd = resolve(repoRoot, flag(argv, '--tests-cwd') ?? '.')
    const failing = failingTestFilesFromJunit(readFileSync(junit, 'utf8'), testsCwd)
    const { selected } = prePushSelection(repoRoot, flag(argv, '--base'))
    for (const line of escapeReportLines(repoRoot, failing, selected)) process.stdout.write(`${line}\n`)
  } catch (error) {
    process.stdout.write(`vinaya escape report: could not run — ${(error as Error).message}\n`)
  }
}

function main(): void {
  const repoRoot = process.cwd()
  const argv = process.argv.slice(2)
  if (argv.includes('--escape-report')) {
    escapeReport(repoRoot, argv)
    return
  }

  const started = performance.now()
  const { selected, totalTestFiles, resolver, programMs } = prePushSelection(repoRoot)
  const elapsed = performance.now() - started

  for (const file of selected) process.stdout.write(`${file}\n`)
  // Selector runtime is reported on its own, and split from the compiler
  // program build inside it, so a push-time budget can be judged against the
  // selector rather than against the tests it goes on to run.
  process.stderr.write(
    `vinaya pre-push: selected ${selected.length} of ${totalTestFiles} test file(s) ` +
      `[${resolver}, ${elapsed.toFixed(0)} ms selector, ${programMs.toFixed(0)} ms program]\n`
  )
}

main()

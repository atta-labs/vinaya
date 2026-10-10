import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CheckError } from '../../src/checks/contract'

// Bin-level tests for check-doc-claims.ts — the pure evaluator
// (`checkDocClaims`, aeg-core) has its own unit suite fed hand-built file
// lists; this file exercises the bin's own I/O: `git ls-files` corpus
// discovery, the tracked-only cited-file reader, and the exit code a real
// spawn reports to the runner.

const BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-doc-claims.ts')

let roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A throwaway git repo holding one doctrine page and one cited source file, both tracked. */
function newRepo(doc: string, cited: string): string {
  const raw = join(tmpdir(), `vinaya-doc-claims-bin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(raw, { recursive: true })
  const root = realpathSync(raw)
  roots.push(root)
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  mkdirSync(join(root, 'aeg-root'), { recursive: true })
  mkdirSync(join(root, 'apps', 'demo'), { recursive: true })
  writeFileSync(join(root, 'aeg-root', 'doc.md'), doc)
  writeFileSync(join(root, 'apps', 'demo', 'code.ts'), cited)
  git(root, ['add', '-A'])
  return root
}

async function runBin(cwd: string): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(['bun', BIN], { cwd, stdout: 'pipe', stderr: 'pipe', env: process.env })
  const exitCode = await proc.exited
  const stderr = await new Response(proc.stderr).text()
  const stdout = await new Response(proc.stdout).text()
  return { exitCode, stderr, stdout }
}

function parseFindings(stderr: string): CheckError[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CheckError)
}

const CITED = "export const greeting = 'hello'\n"

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('check-doc-claims bin', () => {
  it('passes a binding whose cited file holds its literal, noting the verified count', async () => {
    const root = newRepo(
      "The greeting is hello.\n<!-- AEG:CLAIM: apps/demo/code.ts contains:greeting = 'hello' -->\n",
      CITED
    )
    const { exitCode, stderr, stdout } = await runBin(root)
    expect(stderr.trim()).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('doc-claims: 1 binding(s) verified')
  })

  it('fails a stale binding whose cited file no longer holds its literal', async () => {
    const root = newRepo(
      "The greeting is goodbye.\n<!-- AEG:CLAIM: apps/demo/code.ts contains:greeting = 'goodbye' -->\n",
      CITED
    )
    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(1)
    const findings = parseFindings(stderr)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.check).toBe('doc-claims')
    expect(findings[0]?.severity).toBe('error')
    expect(findings[0]?.file).toBe('aeg-root/doc.md')
    expect(findings[0]?.line).toBe(2)
    expect(findings[0]?.message).toContain('no longer holds')
  })

  it('fails a malformed marker that parses as neither form', async () => {
    const root = newRepo(
      "The greeting is hello.\n<!-- AEG:CLAIM: apps/demo/code.ts holds:greeting = 'hello' -->\n",
      CITED
    )
    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(1)
    const findings = parseFindings(stderr)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(2)
    expect(findings[0]?.message).toContain('parses as neither form')
  })

  it('fails a marker with prose after the closing comment on its own line', async () => {
    const root = newRepo(
      "<!-- AEG:CLAIM: apps/demo/code.ts contains:greeting = 'hello' --> The greeting is hello.\n",
      CITED
    )
    const { exitCode } = await runBin(root)
    expect(exitCode).toBe(1)
  })

  it('never reads a cited file git does not track', async () => {
    const root = newRepo('<!-- AEG:CLAIM: apps/demo/secret.ts contains:token -->\n', CITED)
    writeFileSync(join(root, 'apps', 'demo', 'secret.ts'), 'const token = 1\n')
    const { exitCode, stderr } = await runBin(root)
    expect(exitCode).toBe(1)
    expect(parseFindings(stderr)[0]?.message).toContain('could not be read')
  })
})

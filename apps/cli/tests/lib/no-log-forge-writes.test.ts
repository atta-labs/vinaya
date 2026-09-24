/**
 * O4 (task-files-v1 6): a repository test proving no source file posts a log
 * comment or uploads a log artifact — the durable regression guard against a
 * later change reintroducing either. `log-callers.test.ts` already proves the
 * narrower "who may touch the outbox / call `log()`" claims; this file is the
 * one dedicated home for the broader, tracker/artifact-facing claim the O4
 * objective names, so a future PR looking for "does this repo still forbid
 * publishing telemetry to a tracker or a CI artifact" has exactly one file to
 * find, not a claim folded into a differently-scoped test.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentVendor } from '../../src/lib/agent-vendors.js'
import { buildInitOps } from '../../src/lib/artifacts.js'
import type { VendoredVinaya } from '../../src/lib/self-host.js'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')

function sourceFiles(dir: string, prefix: string): [string, string][] {
  const out: [string, string][] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const abs = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.turbo') continue
    if (entry.isDirectory()) {
      out.push(...sourceFiles(abs, rel))
      continue
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
    out.push([rel, abs])
  }
  return out
}

/** Every non-test `.ts`/`.tsx` file under `apps/cli/src` and each `packages/<name>/src`, repo-relative — mirrors `log-callers.test.ts`'s own walker. */
function allSourceFiles(): [string, string][] {
  const out: [string, string][] = [...sourceFiles(join(REPO_ROOT, 'apps/cli/src'), 'apps/cli/src')]
  const packagesDir = join(REPO_ROOT, 'packages')
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    out.push(...sourceFiles(join(packagesDir, pkg.name, 'src'), `packages/${pkg.name}/src`))
  }
  return out
}

describe('no source file posts a log comment or uploads a log artifact (O4)', () => {
  const files = allSourceFiles()
  expect(files.length).toBeGreaterThan(0)

  it('no file constructs the tracker comment marker the deleted flush used to post', () => {
    // A real construction site interpolates a value right after the marker
    // prefix (`` `<!-- aeg:log:${... `` — the exact shape `logForFlush` used
    // to build); a doc comment describing the historical format in prose
    // (`<!-- aeg:log:<run_id>:<seq_from>-<seq_to> -->`, `store.ts`/`schema.ts`
    // still explain it for backward-compat reading) never contains that
    // interpolation and must not trip this check.
    const constructsMarker = /`<!--\s*aeg:log:\$\{/
    const offenders = files.filter(([, abs]) => constructsMarker.test(readFileSync(abs, 'utf8'))).map(([rel]) => rel)
    expect(offenders).toEqual([])
  })

  it('the deleted flush and artifact modules are gone, not merely emptied', () => {
    const existing = new Set(files.map(([rel]) => rel))
    for (const rel of [
      'apps/cli/src/commands/log.ts',
      'apps/cli/src/lib/log-flush.ts',
      'apps/cli/src/lib/log-artifact.ts',
      'packages/aeg-core/src/log/artifact.ts'
    ]) {
      expect(existing.has(rel), `${rel} should not exist`).toBe(false)
    }
  })

  it("no file defines the deleted flush's own chunking/posting functions", () => {
    // `\bflushOutbox\b` alone would still match the historical name inside
    // `flushOutboxToWebhook` — `log-webhook-drain.ts`'s own doc comment
    // legitimately names what it was renamed FROM (task-files-v1 6, O1) —
    // so `flushOutbox` is checked with a negative lookahead excluding that
    // one real collision, never a bare substring test.
    const deletedIdentifierPatterns = [
      /\bflushOutbox(?!ToWebhook)\b/,
      /\bplanFlush\b/,
      /\bexistingLogMarkers\b/,
      /\blogExportArtifactCommand\b/,
      /\blogCollectArtifactCommand\b/,
      /\bexportTaskLogArtifact\b/,
      /\bcollectTaskLogArtifact\b/,
      /\bvalidateTaskLogArtifact\b/
    ]
    const offenders = files
      .filter(([, abs]) => {
        const content = readFileSync(abs, 'utf8')
        return deletedIdentifierPatterns.some((pattern) => pattern.test(content))
      })
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
  })

  it('no file references `actions/upload-artifact` at all — the log-artifact upload step is deleted outright, not merely renamed', () => {
    const offenders = files
      .filter(([, abs]) => readFileSync(abs, 'utf8').includes('actions/upload-artifact'))
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
  })

  it('no file runs the retired collector command — the one allowed mention of its workflow FILENAME is the stale-path constant `upgrade` uses to remove it from an adopter', () => {
    // `artifacts.ts`'s `TASK_LOG_COLLECTOR_WORKFLOW_PATH` constant deliberately
    // still names the retired file, so `vinaya upgrade` can find and delete it
    // from a repo that has it (see `apps/cli/specs/self-hosting.md` §
    // Retiring a managed file) — that is the file being named for removal,
    // never a caller invoking it.
    const allowlist = new Set(['apps/cli/src/lib/artifacts.ts'])
    const offenders = files
      .filter(([rel, abs]) => {
        if (allowlist.has(rel)) return false
        const content = readFileSync(abs, 'utf8')
        return content.includes('vinaya-task-log-collector') || content.includes('log collect-artifact')
      })
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
  })
})

describe('the generated workflow set carries neither (O2/O4)', () => {
  function opsFor(selfHost: VendoredVinaya | null): ReturnType<typeof buildInitOps> {
    return buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    })
  }

  it('no generated workflow file uploads an artifact or triggers on workflow_run', () => {
    const workflowOps = opsFor(null).filter(
      (o): o is Extract<typeof o, { kind: 'create-file' }> => o.kind === 'create-file' && o.path.endsWith('.yml')
    )
    expect(workflowOps.length).toBeGreaterThan(0)
    for (const op of workflowOps) {
      expect(op.content, `${op.path} references actions/upload-artifact`).not.toContain('actions/upload-artifact')
      expect(op.content, `${op.path} triggers on workflow_run`).not.toContain('workflow_run:')
    }
  })

  it('no generated op registers the collector workflow path', () => {
    const found = opsFor(null).find((o) => o.kind === 'create-file' && o.path.includes('task-log-collector'))
    expect(found).toBeUndefined()
  })
})

describe("this repository's own checked-in workflows carry neither (O2/O4)", () => {
  const workflowsDir = join(REPO_ROOT, '.github', 'workflows')

  it('no checked-in workflow file is the retired collector', () => {
    expect(existsSync(join(workflowsDir, 'vinaya-task-log-collector.yml'))).toBe(false)
  })

  it('no checked-in workflow triggers on workflow_run — the collector was the only one', () => {
    const names = readdirSync(workflowsDir).filter((n) => n.endsWith('.yml'))
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const content = readFileSync(join(workflowsDir, name), 'utf8')
      expect(content, `${name} triggers on workflow_run`).not.toContain('workflow_run:')
    }
  })

  it("no checked-in workflow uploads or references a task-log artifact — this repo's own hand-written ci.yml uploads an UNRELATED shared build artifact, which this check must not flag", () => {
    const names = readdirSync(workflowsDir).filter((n) => n.endsWith('.yml'))
    for (const name of names) {
      const content = readFileSync(join(workflowsDir, name), 'utf8')
      expect(content, `${name} references vinaya-task-log`).not.toContain('vinaya-task-log')
      expect(content, `${name} exports a task-log artifact`).not.toContain('log export-artifact')
    }
  })
})

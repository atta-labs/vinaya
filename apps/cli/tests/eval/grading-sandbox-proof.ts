/**
 * The live proof of the Developer grading sandbox. A planted test file is
 * graded through the production entry point (`gradeInSandbox` over
 * `openGradingSandbox`), exactly as a trial's hidden tests are, and records
 * what it could do from inside: write outside the scratch directory, reach the
 * network, and read a forge, log or vendor token from its environment. Every
 * denial is then judged by its own observed outcome — the escaped file absent,
 * the host listener never connected to, the planted token values absent from
 * every view of the child's environment.
 *
 * It needs the pinned Codex CLI and an OS that lets `codex sandbox` start, so
 * it runs where `codex` is installed and in the sandbox-conformance suite.
 */

import { expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gradeInSandbox, openGradingSandbox } from '../../src/lib/dev-review-eval/step-one.js'

/** The forge, log and vendor credential names a host may carry; each is planted with a unique value. */
export const PLANTED_TOKEN_NAMES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'VINAYA_LOG_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY'
] as const

export interface GradingSandboxProof {
  /** The planted test's own report of each attempt: `allowed`, or `denied: <error>`. */
  probe: { outsideWrite: string; slashTmpWrite: string; localNetwork: string; remoteNetwork: string } | null
  /** Whether either escaped file exists on the host after the run. */
  escapedFiles: string[]
  /** Connections the host-side listener accepted from the graded test. */
  connections: number
  /** Every view of the child environment the planted test captured, joined. */
  environment: string
  /** The values planted under `PLANTED_TOKEN_NAMES` in the grading parent's environment. */
  plantedValues: string[]
  /** The scratch directory the sandbox gave the child as `TMPDIR`. */
  scratch: string
}

const plantedTest = (outside: string, slashTmp: string, localUrl: string): string => `import { test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const attempt = async (action: () => unknown): Promise<string> => {
  try {
    await action()
    return 'allowed'
  } catch (error) {
    return \`denied: \${(error as { code?: string }).code ?? (error as Error).message ?? String(error)}\`
  }
}

test('probe the grading boundary', async () => {
  const outsideWrite = await attempt(() => writeFileSync(${JSON.stringify(outside)}, 'escaped'))
  const slashTmpWrite = await attempt(() => writeFileSync(${JSON.stringify(slashTmp)}, 'escaped'))
  const localNetwork = await attempt(() => fetch(${JSON.stringify(localUrl)}, { signal: AbortSignal.timeout(5000) }).then((r) => r.text()))
  const remoteNetwork = await attempt(() => fetch('https://example.com', { signal: AbortSignal.timeout(5000) }).then((r) => r.text()))
  let kernel = ''
  try {
    kernel = readFileSync('/proc/self/environ', 'utf8').split('\\0').join('\\n')
  } catch {}
  let spawned = ''
  try {
    spawned = Bun.spawnSync(['/usr/bin/env']).stdout.toString()
  } catch {}
  const environment = [JSON.stringify(process.env), kernel, spawned].join('\\n')
  writeFileSync(
    join(import.meta.dir, 'probe.json'),
    JSON.stringify({ outsideWrite, slashTmpWrite, localNetwork, remoteNetwork, environment })
  )
})
`

export async function proveGradingSandbox(budgetMs = 300_000): Promise<GradingSandboxProof> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grading-sandbox-proof-')))
  const copy = join(root, 'grading')
  const outsideDir = join(root, 'outside')
  mkdirSync(copy)
  mkdirSync(outsideDir)
  const marker = `${process.pid}-${Date.now()}`
  const outside = join(outsideDir, 'escaped')
  const slashTmp = `/tmp/grading-sandbox-proof-${marker}`
  let connections = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      connections++
      return new Response('reached')
    }
  })
  writeFileSync(join(copy, 'package.json'), '{ "name": "grading-sandbox-proof", "private": true }\n')
  writeFileSync(join(copy, 'planted.test.ts'), plantedTest(outside, slashTmp, `http://127.0.0.1:${server.port}/`))
  const saved = new Map(PLANTED_TOKEN_NAMES.map((name) => [name, process.env[name]] as const))
  const plantedValues = PLANTED_TOKEN_NAMES.map((name) => `planted-${name.toLowerCase()}-${marker}`)
  PLANTED_TOKEN_NAMES.forEach((name, index) => {
    process.env[name] = plantedValues[index]
  })
  const sandbox = openGradingSandbox()
  try {
    await gradeInSandbox(sandbox, copy, ['planted.test.ts'], budgetMs)
    const probePath = join(copy, 'probe.json')
    const recorded = existsSync(probePath)
      ? (JSON.parse(readFileSync(probePath, 'utf8')) as NonNullable<GradingSandboxProof['probe']> & {
          environment: string
        })
      : null
    return {
      probe:
        recorded === null
          ? null
          : {
              outsideWrite: recorded.outsideWrite,
              slashTmpWrite: recorded.slashTmpWrite,
              localNetwork: recorded.localNetwork,
              remoteNetwork: recorded.remoteNetwork
            },
      escapedFiles: [outside, slashTmp].filter((path) => existsSync(path)),
      connections,
      environment: recorded?.environment ?? '',
      plantedValues,
      scratch: sandbox.scratch
    }
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    server.stop(true)
    sandbox.dispose()
    rmSync(slashTmp, { force: true })
    rmSync(root, { recursive: true, force: true })
  }
}

/** Asserts each denial of `proof` by its own observed outcome. */
export function expectGradingSandboxDenies(proof: GradingSandboxProof): void {
  expect(proof.probe, 'the planted test never ran inside the sandbox').not.toBeNull()
  expect(proof.probe?.outsideWrite).toStartWith('denied')
  expect(proof.probe?.slashTmpWrite).toStartWith('denied')
  expect(proof.escapedFiles).toEqual([])
  expect(proof.probe?.localNetwork).toStartWith('denied')
  expect(proof.connections).toBe(0)
  expect(proof.probe?.remoteNetwork).toStartWith('denied')
  // The environment was observed — it names the sandbox's own scratch directory — and holds no planted token.
  expect(proof.environment).toContain(proof.scratch)
  for (const value of proof.plantedValues) expect(proof.environment).not.toContain(value)
  for (const name of PLANTED_TOKEN_NAMES) expect(proof.environment).not.toContain(name)
}

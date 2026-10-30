/**
 * The root-configuration probe: in one real process, outside `bun test` and its
 * preload, prove that the trust-anchor loader reads the configuration COMMITTED
 * at each named ref. Run as `bun scripts/ci/config-probe.ts --base <ref>
 * --candidate <ref>` from the root-config CI job
 * (`apps/cli/specs/self-hosting.md`, "Proving a root-configuration change before
 * merge").
 *
 * Per ref, in order: the existing three-part probe guard
 * (`resolveCiTrustAnchorProbeRef`) must resolve to exactly that ref, before any
 * git read; the committed blob is read through git (never the working tree) and
 * checked against the real schema; then the real loader runs with no injected
 * fetcher and its normalized value must equal the schema's parse of that blob.
 * Output names the ref, presence, digest and a status only — never a config
 * value or a credential. An absent blob is its own status; a malformed blob, a
 * schema mismatch and a failed read are failures, never absence.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import {
  loadTrustAnchorConfigOrThrow,
  resolveCiTrustAnchorProbeRef,
  VinayaConfigSchema
} from '../../apps/cli/src/lib/config'

const CONFIG_PATH = 'vinaya.config.json'
const PROBE_REF_VAR = 'VINAYA_CI_CONFIG_PROBE_REF'

export type ProbeStatus =
  | 'loaded'
  | 'absent'
  | 'guard-inactive'
  | 'ref-unreadable'
  | 'read-failed'
  | 'malformed-json'
  | 'schema-invalid'
  | 'loader-failed'
  | 'value-mismatch'

export type ProbeResult = {
  ref: string
  presence: 'present' | 'absent' | 'unknown'
  /** sha256 of the committed blob's bytes; null when no blob was read. */
  digest: string | null
  status: ProbeStatus
}

/** A probe passes on a loaded value or on a blob that is validly absent at the ref. */
export const probeOk = (result: ProbeResult): boolean => result.status === 'loaded' || result.status === 'absent'

const outcome = (
  ref: string,
  status: ProbeStatus,
  presence: ProbeResult['presence'] = 'unknown',
  digest: string | null = null
): ProbeResult => ({ ref, presence, digest, status })

/**
 * Probes `ref` from the current working directory's repository, reading the
 * process environment. Repository-only helper: the guard is re-checked here, so
 * a caller cannot reach the git read without it.
 */
export function probeCommittedConfig(ref: string): ProbeResult {
  if (resolveCiTrustAnchorProbeRef(process.env) !== ref) return outcome(ref, 'guard-inactive')

  let listing: string
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore', timeout: 10_000 })
    listing = execFileSync('git', ['ls-tree', ref, '--', CONFIG_PATH], { encoding: 'utf-8', timeout: 10_000 })
  } catch {
    return outcome(ref, 'ref-unreadable')
  }
  if (listing.trim() === '') return outcome(ref, 'absent', 'absent')

  let blob: Buffer
  try {
    blob = execFileSync('git', ['show', `${ref}:${CONFIG_PATH}`], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })
  } catch {
    return outcome(ref, 'read-failed', 'present')
  }
  const digest = createHash('sha256').update(blob).digest('hex')

  let json: unknown
  try {
    json = JSON.parse(blob.toString('utf-8'))
  } catch {
    return outcome(ref, 'malformed-json', 'present', digest)
  }
  const parsed = VinayaConfigSchema.safeParse(json)
  if (!parsed.success) return outcome(ref, 'schema-invalid', 'present', digest)

  let loaded: unknown
  try {
    loaded = loadTrustAnchorConfigOrThrow()
  } catch {
    return outcome(ref, 'loader-failed', 'present', digest)
  }
  if (!isDeepStrictEqual(loaded, parsed.data)) return outcome(ref, 'value-mismatch', 'present', digest)
  return { ref, presence: 'present', digest, status: 'loaded' }
}

function argument(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag)
  return i >= 0 ? (argv[i + 1] ?? null) : null
}

/**
 * Refuses before any git read unless the runner marker is set, no forge
 * credential is present and the job declared the candidate ref. Returns the
 * refusal, or null.
 */
function refuseUnlessTestContext(env: NodeJS.ProcessEnv, candidate: string): string | null {
  if (env.GITHUB_ACTIONS !== 'true') return 'GITHUB_ACTIONS is not "true"'
  if ((env.GH_TOKEN ?? '').length > 0 || (env.GITHUB_TOKEN ?? '').length > 0) return 'a forge credential is present'
  const declared = env[PROBE_REF_VAR]?.trim()
  if (!declared) return `${PROBE_REF_VAR} is not set`
  if (declared !== candidate) return `${PROBE_REF_VAR} does not name the candidate ref`
  return null
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const base = argument(argv, '--base')
  const candidate = argument(argv, '--candidate')
  if (!base || !candidate) {
    console.error('usage: bun scripts/ci/config-probe.ts --base <ref> --candidate <ref>')
    return 2
  }
  const refusal = refuseUnlessTestContext(env, candidate)
  if (refusal) {
    console.error(`config-probe refused before any read: ${refusal}`)
    return 1
  }
  let ok = true
  for (const [label, ref] of [
    ['candidate', candidate],
    ['base', base]
  ] as const) {
    process.env[PROBE_REF_VAR] = ref
    const result = probeCommittedConfig(ref)
    console.log(JSON.stringify({ label, ...result }))
    if (!probeOk(result)) ok = false
  }
  process.env[PROBE_REF_VAR] = candidate
  return ok ? 0 : 1
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))

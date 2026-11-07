import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `vinaya release` — the release sequence from `apps/cli/specs/self-hosting.md`
 * ("How the published version is produced") as one command, refusing to
 * start unless every precondition holds.
 *
 * Publishing stays manual and human-triggered — this command removes the
 * four-step recipe a human used to type by hand, plus the `--no-verify` the
 * tag push needed before a real fix made `main-branch-refusal` pass a
 * tag-only push on its own. No token in Actions, no workflow change.
 *
 * Preconditions run in order, each its own refusal naming the fix:
 *   1. HEAD is the default branch (`git symbolic-ref`)
 *   2. the tree is clean (`git status --porcelain`)
 *   3. HEAD equals `origin/<default>` after `git fetch origin`
 *   4. HEAD's subject starts with `Chore(release): Version packages`,
 *      unless `--allow-any-commit`
 *   5. `npm whoami` exits `0`
 *   6. Every fixed-group workspace version is unpublished; read/registry errors refuse
 *
 * Then, streaming each command's own output as it runs: `bun install
 * --frozen-lockfile`, `bun run build`, `bun run changeset:publish`, `git
 * push origin --tags`. That last push is a REAL push — its stdin reaches
 * the repo's own generated pre-push hook exactly as any other `git push`
 * would, which is what populates `VINAYA_PUSH_REFS` and lets
 * `main-branch-refusal` see this is a tag-only push. Nothing here sets that
 * env var itself, and nothing passes `--no-verify`.
 *
 * `--dry-run` runs the preconditions only and prints the plan; it never
 * calls `runStreamed`.
 */

export type ReleasePackage = { name: string; version: string }
export type FixedReleasePackages = { ok: true; packages: ReleasePackage[] } | { ok: false; reason: string }
export type RegistryVersion = { status: 'published' } | { status: 'not-found' } | { status: 'failure'; reason: string }

export type ReleaseDeps = {
  /** `git symbolic-ref --quiet --short HEAD` — `null` on detached HEAD. */
  currentBranch(): string | null
  /** `git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, `origin/` stripped — `null` if unresolvable. */
  defaultBranch(): string | null
  /** `git fetch origin` — `false` on any failure (network, auth). */
  fetchOrigin(): boolean
  /** `git status --porcelain` is empty. */
  treeIsClean(): boolean
  /** `git rev-parse HEAD` — `null` on failure. */
  headSha(): string | null
  /** `git rev-parse origin/<defaultBranch>` — `null` on failure. */
  defaultBranchSha(defaultBranch: string): string | null
  /** `git log -1 --format=%s` — HEAD's commit subject. */
  headSubject(): string
  /** `npm whoami` — `true` on exit `0`. */
  npmWhoami(): boolean
  /** Fixed-group members resolved by workspace package name, or a named read failure. */
  fixedReleasePackages(): FixedReleasePackages
  /** Query exactly this version; only npm's E404 answer means unpublished. */
  npmViewExactVersion(pkg: string, version: string): RegistryVersion
  /** Runs one plan step, streaming its own stdout/stderr live; throws on a non-zero exit. */
  runStreamed(cmd: string, args: string[]): void
  /** `git tag --points-at HEAD` — every tag now sitting on HEAD, e.g. `@attalabs/vinaya@0.24.0`. */
  tagsAtHead(): string[]
  /** `npm view <pkg> version` — `null` on any failure. */
  npmViewVersion(pkg: string): string | null
  /** One line of progress/outcome output — kept separate from `console.log` so tests can capture it without stdout noise. */
  log(message: string): void
}

export function realDeps(): ReleaseDeps {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch {
      return null
    }
  }

  return {
    currentBranch() {
      const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
      return branch === null || branch === '' ? null : branch
    },
    defaultBranch() {
      const ref = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
      if (ref === null || !ref.startsWith('origin/')) return null
      const branch = ref.slice('origin/'.length)
      return branch === '' ? null : branch
    },
    fetchOrigin() {
      try {
        execFileSync('git', ['fetch', 'origin'], { stdio: 'inherit' })
        return true
      } catch {
        return false
      }
    },
    treeIsClean() {
      const status = git(['status', '--porcelain'])
      return status === ''
    },
    headSha() {
      return git(['rev-parse', 'HEAD'])
    },
    defaultBranchSha(defaultBranch) {
      return git(['rev-parse', `origin/${defaultBranch}`])
    },
    headSubject() {
      return git(['log', '-1', '--format=%s']) ?? ''
    },
    npmWhoami() {
      try {
        execFileSync('npm', ['whoami'], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    },
    fixedReleasePackages() {
      let reading = '.changeset/config.json'
      try {
        const config = JSON.parse(readFileSync(reading, 'utf8'))
        if (
          !Array.isArray(config.fixed) ||
          !config.fixed.every(
            (group: unknown) =>
              Array.isArray(group) && group.every((name: unknown) => typeof name === 'string' && name.length > 0)
          )
        ) {
          throw new Error('expected fixed groups of package names')
        }
        const names = [...new Set<string>(config.fixed.flat())]
        const manifests: { name?: unknown; version?: unknown }[] = []
        for (const workspace of ['apps', 'packages']) {
          reading = workspace
          for (const entry of readdirSync(workspace, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            reading = join(workspace, entry.name, 'package.json')
            manifests.push(JSON.parse(readFileSync(reading, 'utf8')))
          }
        }
        const packages: ReleasePackage[] = []
        for (const name of names) {
          reading = name
          const matches = manifests.filter((manifest) => manifest.name === name)
          if (matches.length !== 1) throw new Error(`expected one matching workspace, found ${matches.length}`)
          const version = matches[0]?.version
          if (typeof version !== 'string' || version.trim() === '') throw new Error('missing package version')
          packages.push({ name, version })
        }
        return { ok: true, packages }
      } catch (error) {
        return { ok: false, reason: `${reading}: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
    npmViewExactVersion(pkg, version) {
      try {
        const output = execFileSync('npm', ['view', `${pkg}@${version}`, 'version'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        }).trim()
        if (output === version) return { status: 'published' }
        return { status: 'failure', reason: `unexpected npm view output: ${JSON.stringify(output)}` }
      } catch (error) {
        const failure = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer }
        const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`.trim()
        if (typeof failure.status === 'number' && failure.status !== 0 && /\bE404\b/.test(output)) {
          return { status: 'not-found' }
        }
        return { status: 'failure', reason: output || (error instanceof Error ? error.message : String(error)) }
      }
    },
    runStreamed(cmd, args) {
      execFileSync(cmd, args, { stdio: 'inherit' })
    },
    tagsAtHead() {
      const tags = git(['tag', '--points-at', 'HEAD'])
      if (tags === null || tags === '') return []
      return tags.split('\n').filter((t) => t.length > 0)
    },
    npmViewVersion(pkg) {
      try {
        const out = execFileSync('npm', ['view', pkg, 'version'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        }).trim()
        return out === '' ? null : out
      } catch {
        return null
      }
    },
    log(message) {
      process.stdout.write(`${message}\n`)
    }
  }
}

export const RELEASE_PLAN: readonly (readonly [string, ...string[]])[] = [
  ['bun', 'install', '--frozen-lockfile'],
  ['bun', 'run', 'build'],
  ['bun', 'run', 'changeset:publish'],
  ['git', 'push', 'origin', '--tags']
]

export type PublishedVersion = {
  tag: string
  pkg: string
  version: string
  registryVersion: string | null
  lagExpected: boolean
}

export type ReleaseOutcome =
  | {
      ok: false
      message: string
      /**
       * Set only when the loop failed AFTER `bun run changeset:publish` had
       * already succeeded — packages are on the registry, so this is never
       * a clean refusal. `ranSteps` is every plan step that completed,
       * `failedStep` the one that didn't, `recoveryCommand` the exact
       * remaining plan (joined with `&&`) to run by hand to finish the
       * release. Absent for a pre-publish failure (`bun install`/`bun run
       * build`) or a precondition refusal — those leave nothing to finish.
       */
      ranSteps?: readonly (readonly [string, ...string[]])[]
      failedStep?: readonly [string, ...string[]]
      recoveryCommand?: string
    }
  | { ok: true; dryRun: true; plan: readonly (readonly [string, ...string[]])[] }
  | { ok: true; dryRun: false; published: PublishedVersion[] }

/** Splits `@scope/name@version` on its LAST `@` — the package name's own leading `@` is never the split point. `null` for a tag with no version segment at all. */
function parseTag(tag: string): { pkg: string; version: string } | null {
  const at = tag.lastIndexOf('@')
  if (at <= 0) return null
  return { pkg: tag.slice(0, at), version: tag.slice(at + 1) }
}

export function runRelease(opts: { dryRun: boolean; allowAnyCommit: boolean }, deps: ReleaseDeps): ReleaseOutcome {
  const current = deps.currentBranch()
  const defaultBranch = deps.defaultBranch()

  if (defaultBranch === null) {
    return {
      ok: false,
      message:
        "vinaya release: could not determine this repo's default branch (no resolvable `origin/HEAD`) — run `git remote set-head origin -a` first."
    }
  }

  if (current !== defaultBranch) {
    return {
      ok: false,
      message: `vinaya release: HEAD is on \`${current ?? '(detached)'}\`, not the default branch \`${defaultBranch}\` — check out \`${defaultBranch}\` first.`
    }
  }

  if (!deps.treeIsClean()) {
    return {
      ok: false,
      message: 'vinaya release: working tree is dirty — commit or stash your changes first.'
    }
  }

  if (!deps.fetchOrigin()) {
    return {
      ok: false,
      message: 'vinaya release: `git fetch origin` failed — check your network/auth and try again.'
    }
  }

  const head = deps.headSha()
  const originSha = deps.defaultBranchSha(defaultBranch)
  if (head === null || originSha === null || head !== originSha) {
    return {
      ok: false,
      message: `vinaya release: HEAD does not equal \`origin/${defaultBranch}\` — run \`git pull --ff-only\` first.`
    }
  }

  const subject = deps.headSubject()
  if (!opts.allowAnyCommit && !subject.startsWith('Chore(release): Version packages')) {
    return {
      ok: false,
      message: `vinaya release: HEAD's commit "${subject}" is not a Version Packages commit — merge the Version Packages PR first, or pass \`--allow-any-commit\`.`
    }
  }

  if (!deps.npmWhoami()) {
    return {
      ok: false,
      message: 'vinaya release: `npm whoami` failed — run `npm login` first.'
    }
  }

  const fixed = deps.fixedReleasePackages()
  if (!fixed.ok)
    return { ok: false, message: `vinaya release: could not read fixed release packages — ${fixed.reason}` }
  const refusals: string[] = []
  for (const { name, version } of fixed.packages) {
    const answer = deps.npmViewExactVersion(name, version)
    if (answer.status === 'published') refusals.push(`${name}@${version} is already published`)
    if (answer.status === 'failure') refusals.push(`${name}@${version}: registry query failed — ${answer.reason}`)
  }
  if (refusals.length > 0) return { ok: false, message: `vinaya release: ${refusals.join('; ')}` }

  if (opts.dryRun) {
    return { ok: true, dryRun: true, plan: RELEASE_PLAN }
  }

  const ranSteps: (readonly [string, ...string[]])[] = []
  let publishedAlready = false

  for (const step of RELEASE_PLAN) {
    const [cmd, ...args] = step
    deps.log(`vinaya release: running \`${step.join(' ')}\``)
    try {
      deps.runStreamed(cmd, args)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (!publishedAlready) {
        return { ok: false, message: `vinaya release: \`${step.join(' ')}\` failed — ${reason}` }
      }
      const recoveryCommand = RELEASE_PLAN.slice(ranSteps.length)
        .map((s) => s.join(' '))
        .join(' && ')
      return {
        ok: false,
        message: `vinaya release: \`${step.join(' ')}\` failed after publish already succeeded — packages are on the registry, the release is not finished. Ran: ${ranSteps.map((s) => s.join(' ')).join(', ') || '(nothing)'}. Failed: \`${step.join(' ')}\` — ${reason}. Finish by hand: \`${recoveryCommand}\``,
        ranSteps: [...ranSteps],
        failedStep: step,
        recoveryCommand
      }
    }
    deps.log(`vinaya release: \`${step.join(' ')}\` done`)
    ranSteps.push(step)
    if (cmd === 'bun' && args.join(' ') === 'run changeset:publish') publishedAlready = true
  }

  const published: PublishedVersion[] = []
  for (const tag of deps.tagsAtHead()) {
    const parsed = parseTag(tag)
    if (parsed === null) continue
    const registryVersion = deps.npmViewVersion(parsed.pkg)
    const lagExpected = parsed.pkg === '@attalabs/vinaya' && registryVersion !== parsed.version
    published.push({ tag, pkg: parsed.pkg, version: parsed.version, registryVersion, lagExpected })
  }

  return { ok: true, dryRun: false, published }
}

export async function releaseCommand(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run')
  const allowAnyCommit = args.includes('--allow-any-commit')
  const deps = realDeps()

  const outcome = runRelease({ dryRun, allowAnyCommit }, deps)

  if (!outcome.ok) {
    console.error(outcome.message)
    process.exit(1)
  }

  if (outcome.dryRun) {
    deps.log('vinaya release --dry-run: preconditions pass. Plan:')
    for (const step of outcome.plan) deps.log(`  ${step.join(' ')}`)
    process.exit(0)
  }

  for (const p of outcome.published) {
    const registry = p.registryVersion ?? '(not found)'
    if (p.lagExpected) {
      deps.log(`${p.tag}: npm view reports \`${registry}\` — registry lag expected (~20 min)`)
    } else {
      deps.log(`${p.tag}: npm view reports \`${registry}\``)
    }
  }
  process.exit(0)
}

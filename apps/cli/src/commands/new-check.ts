import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { coreCheckRegistry } from '../checks/registry.js'
import { isValidNamespacedKey } from '../checks/resolver.js'
import { packageRoot } from '../lib/package-root.js'

const TEMPLATE_PATH = join(packageRoot(import.meta.url), 'templates', 'custom-check.template.ts')
const CHECKS_DIR = join('scripts', 'vinaya-checks')

const USAGE =
  'Usage: vinaya new check <yourname>/<id>  (both segments: lowercase letters, digits, hyphens; e.g. myteam/vocab-check)'

/**
 * `vinaya new check <yourname>/<id>` — scaffolds a worked custom check into
 * `./scripts/vinaya-checks/<id>.ts`. The template is self-contained (no
 * dependency on `@attalabs/vinaya`'s own source) and honors the check
 * contract out of the box: it runs, emits one real `CheckError`, and passes
 * through the runner unmodified (`tests/new-check.test.ts`).
 *
 * The name it accepts is the REGISTRATION KEY, validated by the resolver's
 * own `isValidNamespacedKey` rather than by a second copy of the grammar —
 * the scaffolder previously took a bare `[a-z0-9][a-z0-9-]*` name and
 * printed it as a `checks` key, which the execution flip made fatal: every
 * name it could accept is a key `vinaya check` now refuses the whole run
 * over. A core id is refused too, and deliberately not treated as a
 * shorthand for "override that check": replacing a core gate is a real
 * governance decision, and a scaffolded stub that always exits 1 is never
 * what an adopter means by it.
 */
export function newCheckCommand(args: string[]): void {
  const name = args[0]
  if (!name) {
    console.error(USAGE)
    process.exit(2)
  }
  if (coreCheckRegistry().some((spec) => spec.name === name)) {
    console.error(
      `Refusing: "${name}" is a core check id. Registering it under \`checks\` REPLACES that core check — the core one stops running — so a scaffolded stub is never the right shape for it. Pick a namespaced name, or write the override entry by hand if you really mean to replace the core check.`
    )
    process.exit(2)
  }
  if (!isValidNamespacedKey(name)) {
    console.error(
      `Refusing: "${name}" is not a valid check id. ${USAGE.slice('Usage: '.length)}\n\`vinaya check\` refuses the entire run over a key it cannot resolve, so a bare, un-namespaced name would brick every check invocation in this repo.`
    )
    process.exit(2)
  }

  const scriptsDir = join(process.cwd(), CHECKS_DIR)
  if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true })

  // The registration key carries a `/`; the file on disk cannot. The
  // segment after the slash is the filename, the full key stays the id.
  const fileStem = name.slice(name.indexOf('/') + 1)
  const targetPath = join(scriptsDir, `${fileStem}.ts`)
  if (existsSync(targetPath)) {
    console.error(`Error: ${targetPath} already exists.`)
    process.exit(1)
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf-8')
  const contents = template.split('{{CHECK_NAME}}').join(name)
  writeFileSync(targetPath, contents, 'utf-8')
  chmodSync(targetPath, 0o755)

  const relPath = join(CHECKS_DIR, `${fileStem}.ts`)
  const registration = JSON.stringify({ checks: { [name]: { run: `./${relPath}`, scope: 'diff' } } }, null, 2)
  process.stdout.write(`Created ${relPath}\n\nRegister it in vinaya.config.json:\n${registration}\n`)
}

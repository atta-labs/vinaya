import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { coreCheckRegistry } from '../checks/registry.js'
import { packageRoot } from '../lib/package-root.js'

const TEMPLATE_PATH = join(packageRoot(import.meta.url), 'templates', 'noop-check.template.ts')
const CHECKS_DIR = join('vinaya', 'checks')

const USAGE =
  'Usage: vinaya new noop-check <core-check-id>  (the exact id of a core check — run `vinaya check --plan` to list them)'

/**
 * `vinaya new noop-check <core-check-id>` — the only sanctioned way to
 * silence a core check. Scaffolds an explicit, contract-satisfying no-op
 * into `./vinaya/checks/<id>.ts` (always exits 0, emits no findings) and
 * prints the `checks` entry that REPLACES the named core check with it.
 *
 * Takes the opposite input `vinaya new check` does: `new check` REFUSES a
 * core check id (registering one REPLACES that core gate, and a generic
 * stub is never what an adopter means by that); `new noop-check` requires
 * one, because replacing a core gate with an explicit, intentional no-op is
 * exactly its job. A namespaced or otherwise unknown name is refused — it
 * would register as a harmless ADDITIVE check via `new check` instead, not
 * silence anything.
 */
export function newNoopCheckCommand(args: string[]): void {
  const name = args[0]
  if (!name) {
    console.error(USAGE)
    process.exit(2)
  }
  const coreSpec = coreCheckRegistry().find((spec) => spec.name === name)
  if (!coreSpec) {
    console.error(
      `Refusing: "${name}" is not a core check id. ${USAGE}\n\`new noop-check\` only silences a CORE check — a \`checks\` key that exactly matches a core check id REPLACES it. A namespaced or unknown name has nothing to replace; use \`vinaya new check\` to scaffold a new, additive check instead.`
    )
    process.exit(2)
  }

  const checksDir = join(process.cwd(), CHECKS_DIR)
  if (!existsSync(checksDir)) mkdirSync(checksDir, { recursive: true })

  const targetPath = join(checksDir, `${name}.ts`)
  if (existsSync(targetPath)) {
    console.error(`Error: ${targetPath} already exists.`)
    process.exit(1)
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf-8')
  const contents = template.split('{{CHECK_NAME}}').join(name)
  writeFileSync(targetPath, contents, 'utf-8')
  chmodSync(targetPath, 0o755)

  const relPath = join(CHECKS_DIR, `${name}.ts`)
  const registration = JSON.stringify({ checks: { [name]: { run: `./${relPath}`, scope: coreSpec.scope } } }, null, 2)
  process.stdout.write(
    `Created ${relPath}\n\nThis REPLACES the core check "${name}" — it will no longer run. Register the no-op in vinaya.config.json:\n${registration}\n`
  )
}

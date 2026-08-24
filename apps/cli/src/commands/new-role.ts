import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValidNamespacedKey } from '../checks/resolver.js'
import { packageRoot } from '../lib/package-root.js'

const TEMPLATE_PATH = join(packageRoot(import.meta.url), 'templates', 'role.template.md')
const ROLES_DIR = join('vinaya', 'roles')

const USAGE =
  'Usage: vinaya new role <yourname>/<id>  (both segments: lowercase letters, digits, hyphens; e.g. acme/qa-lead)'

/**
 * `vinaya new role <yourname>/<id>` — scaffolds an additive role contract
 * into `./vinaya/roles/<id>.md` and prints the `roles` config entry to
 * paste. The name it accepts is the REGISTRATION KEY, validated by the same
 * `isValidNamespacedKey` grammar `../roles/resolver.ts` reuses from the
 * checks resolver — one definition, not a second copy.
 *
 * A bare, un-namespaced key is refused rather than scaffolded: that shape
 * resolves as an OVERRIDE of a core role (`../roles/resolver.ts`), a
 * complete replacement of a core role's contract and a real governance
 * decision this scaffolder does not make on an adopter's behalf. Write that
 * entry by hand if replacing a core role's contract is really what's meant.
 *
 * The scaffolded contract's own `role_id` is set to the key's post-"/"
 * segment — the exact identity `../roles/resolver.ts` requires of an
 * additive entry (task 6's contract) — so the freshly-scaffolded role
 * resolves cleanly on the first `vinaya check --plan`, no hand-editing
 * required beyond replacing the placeholder prose.
 */
export function newRoleCommand(args: string[]): void {
  const name = args[0]
  if (!name) {
    console.error(USAGE)
    process.exit(2)
  }
  if (!isValidNamespacedKey(name)) {
    console.error(
      `Refusing: "${name}" is not a valid role key. ${USAGE.slice('Usage: '.length)}\nA bare, un-namespaced key resolves as an OVERRIDE of a core role — a complete replacement of that role's contract, and a real governance decision this scaffolder does not make for you. Pick a namespaced name, or write the override entry by hand if you really mean to replace a core role's contract.`
    )
    process.exit(2)
  }

  const rolesDir = join(process.cwd(), ROLES_DIR)
  if (!existsSync(rolesDir)) mkdirSync(rolesDir, { recursive: true })

  // The registration key carries a `/`; the file on disk cannot. The
  // segment after the slash is both the filename and the contract's own
  // `role_id` — the identity the resolver requires of an additive entry.
  const roleId = name.slice(name.indexOf('/') + 1)
  const targetPath = join(rolesDir, `${roleId}.md`)
  if (existsSync(targetPath)) {
    console.error(`Error: ${targetPath} already exists.`)
    process.exit(1)
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf-8')
  const contents = template.split('{{ROLE_ID}}').join(roleId)
  writeFileSync(targetPath, contents, 'utf-8')

  const relPath = join(ROLES_DIR, `${roleId}.md`)
  const registration = JSON.stringify({ roles: { [name]: { contract: `./${relPath}` } } }, null, 2)
  process.stdout.write(`Created ${relPath}\n\nRegister it in vinaya.config.json:\n${registration}\n`)
}

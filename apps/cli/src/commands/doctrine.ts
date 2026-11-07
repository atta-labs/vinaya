// `vinaya doctrine` — print where the bundled doctrine lives on THIS machine.
//
// The committed root `AGENTS.md` pointer deliberately carries no filesystem
// path: the package's install location is a property of each machine, and
// that file is committed for every clone. This command is the resolution step
// the pointer hands the reader. The resolution itself — which doctrine root
// governs, which file a role or a template is — lives in the process
// (`harness/processes/vinaya-strict/tools/doctrine/resolve-doctrine.ts`, read
// through its doctrine map); this command passes it the command line
// package's own root and prints what it resolves.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { printJson } from '../../../../harness/kernel/effects/envelope.js'
import { cliPackageRoot } from '../lib/package-root.js'
import { resolveRoleFile } from '../../../../harness/processes/vinaya-strict/integration/roles/plan.js'
import {
  ENTRY_SEGMENTS,
  listTemplateNames,
  RETIRED_ROLES,
  ROLE_ALIASES,
  resolveDoctrineRoot,
  templatePath
} from '../../../../harness/processes/vinaya-strict/tools/doctrine/resolve-doctrine.js'

export async function doctrineCommand(args: string[]): Promise<void> {
  const root = resolveDoctrineRoot(cliPackageRoot())
  if (root === null) {
    process.stderr.write(
      'vinaya doctrine: no bundled doctrine found next to this CLI install. ' +
        'The doctrine ships inside the @attalabs/vinaya npm package — reinstall it, ' +
        "or, in a repo that vendors the CLI, run the package's bundle-doctrine script first.\n"
    )
    process.exit(1)
  }

  let entry: string
  const roleFlagIndex = args.indexOf('--role')
  const templateFlagIndex = args.indexOf('--template')
  if (roleFlagIndex !== -1 && templateFlagIndex !== -1) {
    process.stderr.write('vinaya doctrine: --role and --template select different files — pass one, not both.\n')
    process.exit(1)
  }
  if (templateFlagIndex !== -1) {
    // The shipped templates are part of the doctrine the package carries, so
    // they resolve through the same root as `--role` and are reachable by an
    // adopter who has no doctrine tree of their own — which is what lets a
    // rendered brief name the PR report by a command instead of by a path only
    // this repository has.
    const requested = args[templateFlagIndex + 1]
    const validTemplateNames = listTemplateNames(root)
    const path = requested === undefined ? null : templatePath(root, requested)
    if (
      requested === undefined ||
      requested.startsWith('--') ||
      !validTemplateNames.includes(requested) ||
      path === null
    ) {
      process.stderr.write(
        `vinaya doctrine --template: '${requested ?? ''}' is not a known template. ` +
          `Valid template names: ${validTemplateNames.join(', ')}\n`
      )
      process.exit(1)
    }
    entry = path
  } else if (roleFlagIndex !== -1) {
    const requested = args[roleFlagIndex + 1]
    // `Object.hasOwn`, never a bare index: a bare lookup reaches
    // `Object.prototype`, so `--role constructor` resolved to a function and
    // crashed instead of producing the ordinary "not a known role" refusal.
    const roleName =
      requested !== undefined
        ? Object.hasOwn(ROLE_ALIASES, requested)
          ? (ROLE_ALIASES[requested] as string)
          : requested
        : undefined
    if (roleName !== undefined && Object.hasOwn(RETIRED_ROLES, roleName)) {
      process.stderr.write(
        `vinaya doctrine --role: '${roleName}' has been retired — use --role ${RETIRED_ROLES[roleName]}.\n`
      )
      process.exit(1)
    }
    // Resolve the (alias-canonicalised) name through the SAME role plan the
    // review loop resolves against (`resolveRoleFile`), so a config override
    // or additive role is served here too. A missing name / a bare `--flag`
    // in the value slot matches no render id, so it falls to the "not a known
    // role" refusal below, which lists the servable names.
    const resolution = await resolveRoleFile(roleName !== undefined && !roleName.startsWith('--') ? roleName : '')
    if (!resolution.available) {
      process.stderr.write(`vinaya doctrine --role: ${resolution.reason}\n`)
      process.exit(1)
    }
    if (!resolution.found) {
      process.stderr.write(
        `vinaya doctrine --role: '${requested ?? ''}' is not a known role. ` +
          `Valid role names: ${resolution.validNames.join(', ')}\n`
      )
      process.exit(1)
    }
    entry = resolution.path
  } else {
    entry = join(root, ...ENTRY_SEGMENTS)
  }

  // `--print` is the one-hop mode: it emits the resolved file's BODY (its
  // frontmatter stripped) instead of the path a caller would otherwise have
  // to read a second time. A role file whose frontmatter carries an
  // `ack-token` gets that token emitted as the output's own first line — the
  // read-receipt each agent role's own text requires its first session
  // message to echo back verbatim. Bare (no `--role`) and `--json` never
  // combine with `--print`: it is its own terminal mode.
  if (args.includes('--print')) {
    const { data, content } = matter(readFileSync(entry, 'utf8'))
    const ackToken = typeof data['ack-token'] === 'string' ? data['ack-token'] : null
    process.stdout.write(ackToken ? `${ackToken}\n${content}` : content)
    return
  }

  if (args.includes('--json')) {
    printJson({ root, entry })
    return
  }
  // Bare output is the entry path alone, so it composes:
  // `cat "$(vinaya doctrine)"` opens the front door directly.
  process.stdout.write(`${entry}\n`)
}

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  doctrine: { date: '2026-09-05', callsToday: 1, retiresVia: 'sharedCommandShell' }
}

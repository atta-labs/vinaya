// Emitter for .agents/skills/vinaya-<role>/SKILL.md
//
// Generates the shared agent-skill surface read natively by Codex, Antigravity,
// and Grok Build. Each emitted file is a 3-line pointer delegating to
// `vinaya doctrine --role <role>` at read time.
//
// Role discovery is live-scanned from the package's resolved `aeg-root/roles/*.md`,
// never hardcoded, so additions to doctrine surface automatically in future upgrades.
//
// Human-only roles are excluded, not just skipped by convention. Every role file's
// frontmatter carries an `actor: human|agent|either` field (`aeg-root/roles/*.md`) —
// `principal` is `actor: human`, the one seat this doctrine deliberately never grants
// an agent. A skill file telling a third-party AI tool to "Act as the AEG Principal"
// would hand that authority to exactly the actor the model withholds it from. Filtered
// on the same structured signal the doctrine already carries, never a hardcoded name
// exclusion — a future human-only role is excluded automatically, the same reason role
// discovery itself is live-scanned rather than hardcoded.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import type { CreateFileOp } from './ops.js'

export const AGENTS_SKILLS_GROUP = 'Agent skills (.agents/skills/)'

/**
 * Format a role slug into a human-readable AEG role title.
 * e.g. "developer" -> "Developer", "brief-author" -> "Brief Author", "tranche-archivist" -> "Tranche Archivist"
 */
export function formatRoleTitle(roleName: string): string {
  return roleName
    .split('-')
    .filter((segment) => segment.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Discover role names available under `<doctrineRoot>/roles/`, from `*.md` filenames —
 * excluding any role whose frontmatter declares `actor: human` (agent-skill files are
 * only ever generated for `agent` or `either` actors). Results are sorted alphabetically
 * for deterministic, idempotent output.
 */
export function discoverRoleNames(doctrineRoot: string): string[] {
  const rolesDir = join(doctrineRoot, 'roles')
  if (!existsSync(rolesDir)) return []
  return readdirSync(rolesDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .filter((roleName) => {
      const { data } = matter(readFileSync(join(rolesDir, `${roleName}.md`), 'utf8'))
      return data.actor !== 'human'
    })
    .sort()
}

/** The relative path for an agent skill file under .agents/skills/. */
export function agentSkillPath(roleName: string): string {
  return `.agents/skills/vinaya-${roleName}/SKILL.md`
}

/** Render the 3-line pointer content for an agent skill. */
export function renderAgentSkill(roleName: string): string {
  const roleTitle = formatRoleTitle(roleName)
  return `---
name: vinaya-${roleName}
description: Act as the AEG ${roleTitle} for this repo.
---
Run \`vinaya doctrine --role ${roleName}\` and follow its output as your operating instructions for this session.
`
}

/** Build the list of `create-file` ops for discovered roles under `.agents/skills/`. */
export function buildAgentsSkillsOps(doctrineRoot: string): CreateFileOp[] {
  const roles = discoverRoleNames(doctrineRoot)
  return roles.map((role) => ({
    kind: 'create-file',
    path: agentSkillPath(role),
    content: renderAgentSkill(role),
    group: AGENTS_SKILLS_GROUP
  }))
}

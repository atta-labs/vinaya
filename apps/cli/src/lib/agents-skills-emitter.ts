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
import type { VendoredVinaya } from './self-host.js'

export const AGENTS_SKILLS_GROUP = 'Agent skills (.agents/skills/)'

/**
 * Format a role slug into a human-readable AEG role title.
 * e.g. "developer" -> "Developer", "planner" -> "Planner", "tranche-archivist" -> "Tranche Archivist"
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

/**
 * The doctrine invocation this skill points at — the source CLI
 * (`bun <dir>/src/index.ts doctrine`) in a repo that vendors `vinaya` as a
 * workspace member, the global binary otherwise. A self-hosting repo's own
 * `.agents/skills/` must invoke the CLI it is actually editing, never
 * whatever release the global install happens to be at (atta-labs/vinaya#408).
 */
function doctrineInvocation(selfHost: VendoredVinaya | null): string {
  return selfHost ? `bun ${selfHost.dir}/src/index.ts doctrine` : 'vinaya doctrine'
}

/** Render the 3-line pointer content for an agent skill. */
export function renderAgentSkill(roleName: string, selfHost: VendoredVinaya | null = null): string {
  const roleTitle = formatRoleTitle(roleName)
  return `---
name: vinaya-${roleName}
description: Act as the AEG ${roleTitle} for this repo.
---
Run \`${doctrineInvocation(selfHost)} --role ${roleName}\` and follow its output as your operating instructions for this session.
`
}

/** Build the list of `create-file` ops for discovered roles under `.agents/skills/`. */
export function buildAgentsSkillsOps(doctrineRoot: string, selfHost: VendoredVinaya | null = null): CreateFileOp[] {
  const roles = discoverRoleNames(doctrineRoot)
  return roles.map((role) => ({
    kind: 'create-file',
    path: agentSkillPath(role),
    content: renderAgentSkill(role, selfHost),
    group: AGENTS_SKILLS_GROUP
  }))
}

/** Matches `agentSkillPath`'s own shape, capturing the role slug back out. */
const AGENT_SKILL_PATH_PATTERN = /^\.agents\/skills\/vinaya-([^/]+)\/SKILL\.md$/

/**
 * Manifest-recorded agent-skill paths whose role no longer resolves under
 * `<doctrineRoot>/roles/` (deleted outright, or now `actor: human`) — a
 * generated skill left pointing at `vinaya doctrine --role <retired>`, which
 * now refuses. Never hardcodes a role name: the same live-scan
 * `discoverRoleNames` already uses, diffed against what a past `init`/`upgrade`
 * actually wrote, so any future retired role is caught the same way.
 */
export function staleAgentSkillPaths(doctrineRoot: string, manifestFiles: readonly string[]): string[] {
  const liveRoles = new Set(discoverRoleNames(doctrineRoot))
  return manifestFiles.filter((path) => {
    const match = AGENT_SKILL_PATH_PATTERN.exec(path)
    return match !== null && !liveRoles.has(match[1] as string)
  })
}

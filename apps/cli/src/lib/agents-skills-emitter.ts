// Emitter for .agents/skills/vinaya-<role>/SKILL.md and
// .claude/skills/vinaya-<role>/SKILL.md
//
// Generates the role-skill surface twice, once per directory a host scans:
// `.agents/skills/` is read natively by Codex, Gemini CLI, Antigravity and
// Grok Build; `.claude/skills/` is the only skill directory Claude Code reads.
// The two files carry the same pointer and the same vendor-neutral `name` and
// `description`; only the Claude file carries Claude-only frontmatter
// (`allowed-tools`), since Codex documents nothing but `name` and
// `description` there. Each emitted file is a 3-line pointer delegating to
// `vinaya doctrine --role <role> --print` at read time — one hop: the
// pointer's own output IS the role's operating instructions, not a second
// path the agent must read again.
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
export const CLAUDE_SKILLS_GROUP = 'Claude Code skills (.claude/skills/)'

/**
 * Which skill directory a generated file lands in: `agents` for the portable
 * `.agents/skills/` (installed under the `skills` vendor), `claude` for
 * Claude Code's `.claude/skills/` (installed under the `claude` vendor).
 */
export type SkillTarget = 'agents' | 'claude'

const SKILL_DIRS: Record<SkillTarget, string> = { agents: '.agents/skills', claude: '.claude/skills' }
const SKILL_GROUPS: Record<SkillTarget, string> = { agents: AGENTS_SKILLS_GROUP, claude: CLAUDE_SKILLS_GROUP }

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
 * Roles this codebase has retired, declared rather than inferred.
 *
 * Retirement is a STATED fact, never derived from a role file's absence. The
 * doctrine file may legitimately outlive the code's knowledge of the role —
 * `aeg-root/roles/brief-author.md` stays on disk until the doctrine task
 * deletes it, because `registry-gates`' G5 refuses a contract naming a role
 * with no file. Inferring "retired" from a missing file therefore gets BOTH
 * consumers of `discoverRoleNames` wrong while that window is open:
 * `staleAgentSkillPaths` would keep reading an adopter's stale skill as live
 * and never clean it up, and `agentSkillsArtifacts` would keep GENERATING a
 * skill whose embedded `vinaya doctrine --role brief-author` this same release
 * makes refuse — an artifact broken by construction the moment it is written.
 *
 * A name here stays correct, merely redundant, once its role file is deleted.
 */
export const RETIRED_ROLE_NAMES: ReadonlySet<string> = new Set(['brief-author'])

/**
 * Discover role names available under `<doctrineRoot>/roles/`, from `*.md` filenames —
 * excluding any role whose frontmatter declares `actor: human` (agent-skill files are
 * only ever generated for `agent` or `either` actors) and any role named in
 * `RETIRED_ROLE_NAMES`. Results are sorted alphabetically for deterministic,
 * idempotent output.
 */
export function discoverRoleNames(doctrineRoot: string): string[] {
  const rolesDir = join(doctrineRoot, 'roles')
  if (!existsSync(rolesDir)) return []
  return readdirSync(rolesDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .filter((roleName) => !RETIRED_ROLE_NAMES.has(roleName))
    .filter((roleName) => {
      const { data } = matter(readFileSync(join(rolesDir, `${roleName}.md`), 'utf8'))
      return data.actor !== 'human'
    })
    .sort()
}

/** The relative path for a role skill file under `.agents/skills/` or `.claude/skills/`. */
export function agentSkillPath(roleName: string, target: SkillTarget = 'agents'): string {
  return `${SKILL_DIRS[target]}/vinaya-${roleName}/SKILL.md`
}

/**
 * The doctrine invocation this skill points at — the source CLI
 * (`bun <dir>/src/index.ts doctrine`) in a repo that vendors `vinaya` as a
 * workspace member, the global binary otherwise. A self-hosting repo's own
 * `.agents/skills/` must invoke the CLI it is actually editing, never
 * whatever release the global install happens to be at.
 */
function doctrineInvocation(selfHost: VendoredVinaya | null): string {
  return selfHost ? `bun ${selfHost.dir}/src/index.ts doctrine` : 'vinaya doctrine'
}

/**
 * Read a role file's `allowed-tools` frontmatter as a normalized string list —
 * a YAML list (`- task_start`) or a comma-separated inline value both parse to
 * the same array; anything else (absent, malformed, empty) yields `[]`. A role
 * that declares a tool grant (today, only the Operator) carries it here so the
 * generated skill can surface the SAME grant the role doc and the router
 * enforce; a role with no grant is unchanged.
 */
export function roleAllowedTools(doctrineRoot: string, roleName: string): string[] {
  const file = join(doctrineRoot, 'roles', `${roleName}.md`)
  if (!existsSync(file)) return []
  const { data } = matter(readFileSync(file, 'utf8'))
  const raw = data['allowed-tools']
  if (Array.isArray(raw))
    return raw
      .map(String)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  if (typeof raw === 'string')
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  return []
}

/**
 * Read a role file's `denied-tools` frontmatter (O3) the same way
 * `roleAllowedTools` reads `allowed-tools` — a YAML list or comma-separated
 * inline value, `[]` when absent/malformed/empty. Every agent role but the
 * Operator declares one: the verbs its own prose already forbids ("never
 * merge", "never write status", …), transcribed as kebab-case entries in the
 * same vocabulary `performs` already uses for what a role DOES.
 */
export function roleDeniedTools(doctrineRoot: string, roleName: string): string[] {
  const file = join(doctrineRoot, 'roles', `${roleName}.md`)
  if (!existsSync(file)) return []
  const { data } = matter(readFileSync(file, 'utf8'))
  const raw = data['denied-tools']
  if (Array.isArray(raw))
    return raw
      .map(String)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  if (typeof raw === 'string')
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  return []
}

/**
 * Render the pointer content for a role skill. On the `claude` target, a
 * role that declares an `allowed-tools` grant gets that grant carried into
 * the generated skill's frontmatter, so Claude Code exposes the SAME grant the
 * role doc and the router enforce. `allowed-tools` is Claude-only frontmatter:
 * the `agents` target never carries it, whatever the role declares, because
 * the hosts reading `.agents/skills/` document only `name` and `description`.
 * A role with no grant renders the same 3-line pointer on both targets.
 *
 * A role's `denied-tools` (O3) are carried as a plain BODY line, never a
 * frontmatter grant, on both targets: `disallowed-tools` is absent from the
 * portable Agent Skills spec the `.agents/skills/` hosts implement, and no
 * host either file reaches has a confirmed mechanism to enforce a tool
 * restriction from it. The denial is real doctrine, just prose-enforced here
 * rather than host-mechanized; the body line keeps it visible rather than
 * silently dropped.
 */
export function renderAgentSkill(
  roleName: string,
  selfHost: VendoredVinaya | null = null,
  allowedTools: readonly string[] = [],
  deniedTools: readonly string[] = [],
  target: SkillTarget = 'agents'
): string {
  const roleTitle = formatRoleTitle(roleName)
  const grantLine = target === 'claude' && allowedTools.length > 0 ? `allowed-tools: ${allowedTools.join(', ')}\n` : ''
  const deniedLine =
    deniedTools.length > 0
      ? `\nDenied — this role's own doctrine forbids: ${deniedTools.join(', ')}. Enforced by doctrine text only: no confirmed host mechanism restricts tool availability from this file.\n`
      : ''
  return `---
name: vinaya-${roleName}
description: Act as the AEG ${roleTitle} for this repo.
${grantLine}---
Run \`${doctrineInvocation(selfHost)} --role ${roleName} --print\` and follow its output as your operating instructions for this session.
${deniedLine}`
}

/** Build the list of `create-file` ops for discovered roles under one target's skill directory. */
export function buildAgentsSkillsOps(
  doctrineRoot: string,
  selfHost: VendoredVinaya | null = null,
  target: SkillTarget = 'agents'
): CreateFileOp[] {
  const roles = discoverRoleNames(doctrineRoot)
  return roles.map((role) => ({
    kind: 'create-file',
    path: agentSkillPath(role, target),
    content: renderAgentSkill(
      role,
      selfHost,
      roleAllowedTools(doctrineRoot, role),
      roleDeniedTools(doctrineRoot, role),
      target
    ),
    group: SKILL_GROUPS[target]
  }))
}

/**
 * Matches `agentSkillPath`'s own shape in either directory, capturing the
 * role slug back out. Only the generated `vinaya-` prefix matches, so a
 * hand-authored skill beside them (`.claude/skills/dispatch-vps/`) never does.
 */
const AGENT_SKILL_PATH_PATTERN = /^\.(?:agents|claude)\/skills\/vinaya-([^/]+)\/SKILL\.md$/

/** `true` for a generated role-skill path in either skill directory. */
export function isAgentSkillPath(path: string): boolean {
  return AGENT_SKILL_PATH_PATTERN.test(path)
}

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

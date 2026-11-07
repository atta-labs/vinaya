import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  agentSkillPath,
  buildAgentsSkillsOps,
  discoverRoleNames,
  isAgentSkillPath,
  formatRoleTitle,
  renderAgentSkill,
  roleDeniedTools,
  staleAgentSkillPaths
} from '../integration/agents-skills-emitter.js'
import { DOCTRINE_TREE, roleEntry } from '../tools/doctrine/doctrine-map.js'

/** Writes a role doctrine file under `root`, at the source path the doctrine map names for the role id (a name the map does not carry lands at `<name>.md`). */
function plantRole(root: string, name: string, content: string): void {
  const path = join(root, roleEntry(name)?.source ?? `${name}.md`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

describe('agents-skills-emitter', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `vinaya-emitter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('formatRoleTitle', () => {
    it('formats single and hyphenated role names into title case', () => {
      expect(formatRoleTitle('developer')).toBe('Developer')
      expect(formatRoleTitle('brief-author')).toBe('Brief Author')
      expect(formatRoleTitle('tranche-archivist')).toBe('Tranche Archivist')
      expect(formatRoleTitle('code-reviewer')).toBe('Code Reviewer')
    })
  })

  describe('discoverRoleNames', () => {
    it('returns sorted role names from roles/*.md fixture', () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      plantRole(tempDir, 'developer', '# Developer\n')
      plantRole(tempDir, 'reviewer', '# Reviewer\n')
      plantRole(tempDir, 'archivist', '# Archivist\n')
      writeFileSync(join(rolesDir, 'ignored.txt'), 'ignore me\n')

      const roles = discoverRoleNames(tempDir)
      expect(roles).toEqual(['archivist', 'developer', 'reviewer'])
    })

    it('returns empty array if roles directory does not exist', () => {
      expect(discoverRoleNames(join(tempDir, 'nonexistent'))).toEqual([])
    })

    it('excludes actor: human roles (principal), includes agent and either', () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      plantRole(tempDir, 'developer', '---\nactor: agent\n---\n# Developer\n')
      plantRole(tempDir, 'principal', '---\nactor: human\n---\n# Principal\n')
      plantRole(tempDir, 'archivist', '---\nactor: either\n---\n# Archivist\n')

      const roles = discoverRoleNames(tempDir)
      expect(roles).toEqual(['archivist', 'developer'])
      expect(roles).not.toContain('principal')
    })

    it('excludes principal against the real bundled doctrine', () => {
      const realRoot = join(import.meta.dir, '..')
      const roles = discoverRoleNames(realRoot)
      expect(roles).not.toContain('principal')
      expect(roles).toContain('developer')
    })
  })

  describe('renderAgentSkill', () => {
    it('matches exact 3-line pointer specification for developer', () => {
      const expected = `---
name: vinaya-developer
description: Act as the Vinaya Developer for this repo.
---
Run \`vinaya doctrine --role developer --print\` and follow its output as your operating instructions for this session.
`
      expect(renderAgentSkill('developer')).toBe(expected)
      expect(agentSkillPath('developer')).toBe('.agents/skills/vinaya-developer/SKILL.md')
    })

    // `renderAgentSkill` is a pure string function; it renders whatever name it
    // is handed. Retirement is enforced upstream, in `discoverRoleNames`, so no
    // caller ever hands it a retired role — this case only pins the hyphenated
    // title formatting.
    it('matches exact 3-line pointer specification for brief-author', () => {
      const expected = `---
name: vinaya-brief-author
description: Act as the Vinaya Brief Author for this repo.
---
Run \`vinaya doctrine --role brief-author --print\` and follow its output as your operating instructions for this session.
`
      expect(renderAgentSkill('brief-author')).toBe(expected)
      expect(agentSkillPath('brief-author')).toBe('.agents/skills/vinaya-brief-author/SKILL.md')
    })
  })

  describe('renderAgentSkill — selfHost (atta-labs/vinaya#408)', () => {
    it('invokes the source CLI when selfHost is set', () => {
      const expected = `---
name: vinaya-developer
description: Act as the Vinaya Developer for this repo.
---
Run \`bun apps/cli/src/index.ts doctrine --role developer --print\` and follow its output as your operating instructions for this session.
`
      expect(renderAgentSkill('developer', { dir: 'apps/cli', bin: 'apps/cli/dist/index.js' })).toBe(expected)
    })

    it('is unchanged for the ordinary adopter when selfHost is explicitly null', () => {
      expect(renderAgentSkill('developer', null)).toBe(renderAgentSkill('developer'))
    })
  })

  describe('two targets: .agents/skills/ and .claude/skills/', () => {
    const OPERATOR_GRANT = ['task_start', 'task_status']

    it('places each target under its own directory, same role slug', () => {
      expect(agentSkillPath('developer', 'agents')).toBe('.agents/skills/vinaya-developer/SKILL.md')
      expect(agentSkillPath('developer', 'claude')).toBe('.claude/skills/vinaya-developer/SKILL.md')
    })

    it('carries allowed-tools only in the Claude file; name and description in both', () => {
      const agents = renderAgentSkill('operator', null, OPERATOR_GRANT, [], 'agents')
      const claude = renderAgentSkill('operator', null, OPERATOR_GRANT, [], 'claude')
      expect(agents).toBe(`---
name: vinaya-operator
description: Act as the Vinaya Operator for this repo.
---
Run \`vinaya doctrine --role operator --print\` and follow its output as your operating instructions for this session.
`)
      expect(claude).toBe(`---
name: vinaya-operator
description: Act as the Vinaya Operator for this repo.
allowed-tools: task_start, task_status
---
Run \`vinaya doctrine --role operator --print\` and follow its output as your operating instructions for this session.
`)
    })

    it('a role with no grant renders byte-identical pointers on both targets', () => {
      expect(renderAgentSkill('developer', null, [], ['merge'], 'claude')).toBe(
        renderAgentSkill('developer', null, [], ['merge'], 'agents')
      )
    })

    it('buildAgentsSkillsOps writes one file per role per target, against the real bundled doctrine', () => {
      const realRoot = join(import.meta.dir, '..')
      const roles = discoverRoleNames(realRoot)
      const agentsOps = buildAgentsSkillsOps(realRoot, null, 'agents')
      const claudeOps = buildAgentsSkillsOps(realRoot, null, 'claude')
      expect(agentsOps.map((op) => op.path)).toEqual(roles.map((r) => agentSkillPath(r, 'agents')))
      expect(claudeOps.map((op) => op.path)).toEqual(roles.map((r) => agentSkillPath(r, 'claude')))
      expect(agentsOps.every((op) => op.group === 'Agent skills (.agents/skills/)')).toBe(true)
      expect(claudeOps.every((op) => op.group === 'Claude Code skills (.claude/skills/)')).toBe(true)
      for (const op of agentsOps) expect(op.content).not.toContain('allowed-tools:')
      const claudeOperator = claudeOps.find((op) => op.path === agentSkillPath('operator', 'claude'))
      expect(claudeOperator?.content).toContain('allowed-tools: task_start')
      for (const op of [...agentsOps, ...claudeOps]) {
        const role = /vinaya-([^/]+)\/SKILL\.md$/.exec(op.path)?.[1] as string
        expect(op.content).toContain(`name: vinaya-${role}\n`)
        expect(op.content).toContain(`--role ${role} --print`)
      }
    })

    it("this repository's committed skill files match the generator for both targets", () => {
      const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
      const selfHost = { dir: 'apps/cli', bin: 'apps/cli/dist/index.js' }
      for (const target of ['agents', 'claude'] as const) {
        for (const op of buildAgentsSkillsOps(join(repoRoot, DOCTRINE_TREE), selfHost, target)) {
          expect(readFileSync(join(repoRoot, op.path), 'utf8'), op.path).toBe(op.content)
        }
      }
    })
  })

  describe('roleDeniedTools & the denied-tools body line (O3)', () => {
    it('reads a YAML list from denied-tools frontmatter', () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      plantRole(
        tempDir,
        'developer',
        '---\nactor: agent\ndenied-tools:\n  - merge\n  - write-status\n---\n# Developer\n'
      )
      expect(roleDeniedTools(tempDir, 'developer')).toEqual(['merge', 'write-status'])
    })

    it('returns [] for a role with no denied-tools frontmatter (the Operator)', () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      plantRole(tempDir, 'operator', '---\nactor: agent\n---\n# Operator\n')
      expect(roleDeniedTools(tempDir, 'operator')).toEqual([])
    })

    it('renders denied tools as a body line, never a frontmatter grant — the host support is unconfirmed for this file', () => {
      const skill = renderAgentSkill('developer', null, [], ['merge', 'write-status'])
      expect(skill).toContain("Denied — this role's own doctrine forbids: merge, write-status.")
      expect(skill).not.toContain('disallowed-tools:')
    })

    it('a role with no denied-tools renders the unchanged pointer (no denial line)', () => {
      expect(renderAgentSkill('operator')).not.toContain('Denied —')
    })

    it('every real agent role but the Operator declares denied-tools against the real bundled doctrine (O3)', () => {
      const realRoot = join(import.meta.dir, '..')
      const roles = discoverRoleNames(realRoot)
      expect(roles).toContain('developer')
      for (const role of roles) {
        const denied = roleDeniedTools(realRoot, role)
        if (role === 'operator') {
          expect(denied).toEqual([])
        } else {
          expect(denied.length, `${role} declares no denied-tools`).toBeGreaterThan(0)
        }
      }
    })

    it('buildAgentsSkillsOps carries denied-tools into the generated skill for a non-Operator role', () => {
      const realRoot = join(import.meta.dir, '..')
      const ops = buildAgentsSkillsOps(realRoot)
      const developerOp = ops.find((op) => op.path === '.agents/skills/vinaya-developer/SKILL.md')
      expect(developerOp?.content).toContain('Denied —')
      const operatorOp = ops.find((op) => op.path === '.agents/skills/vinaya-operator/SKILL.md')
      expect(operatorOp?.content).not.toContain('Denied —')
    })
  })

  describe('staleAgentSkillPaths', () => {
    it('flags a manifest-recorded skill whose role no longer resolves under roles/', () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      plantRole(tempDir, 'developer', '# Developer\n')

      const manifestFiles = [
        '.agents/skills/vinaya-developer/SKILL.md',
        '.agents/skills/vinaya-brief-author/SKILL.md',
        '.vinaya/hooks/pre-commit'
      ]
      expect(staleAgentSkillPaths(tempDir, manifestFiles)).toEqual(['.agents/skills/vinaya-brief-author/SKILL.md'])
    })

    // The real scenario, not a synthetic one: `brief-author.md` is STILL ON
    // DISK — the doctrine task deletes it, not this one, because
    // `registry-gates`' G5 refuses a contract naming a role with no file. A
    // discovery that inferred retirement from the file's absence read the
    // role as live here and never cleaned up an existing adopter's skill.
    // Retirement is declared (`RETIRED_ROLE_NAMES`), so presence is irrelevant.
    it("flags a retired role's skill even while its role file is still present", () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      plantRole(tempDir, 'developer', '# Developer\n')
      plantRole(tempDir, 'brief-author', '# Brief Author\n')

      expect(discoverRoleNames(tempDir)).not.toContain('brief-author')
      expect(discoverRoleNames(tempDir)).toContain('developer')
      expect(
        staleAgentSkillPaths(tempDir, [
          '.agents/skills/vinaya-developer/SKILL.md',
          '.agents/skills/vinaya-brief-author/SKILL.md'
        ])
      ).toEqual(['.agents/skills/vinaya-brief-author/SKILL.md'])
    })

    // The sharper half of the same defect: generation, not just cleanup. A
    // fresh `init`/`upgrade` must not WRITE a skill whose embedded
    // `vinaya doctrine --role brief-author` this same release makes refuse.
    it('never generates an agent skill for a retired role whose file still exists', () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      plantRole(tempDir, 'developer', '# Developer\n')
      plantRole(tempDir, 'brief-author', '# Brief Author\n')

      const paths = buildAgentsSkillsOps(tempDir).map((op) => op.path)
      expect(paths).not.toContain('.agents/skills/vinaya-brief-author/SKILL.md')
      expect(paths).toContain('.agents/skills/vinaya-developer/SKILL.md')
    })

    it('returns empty when every recorded skill still resolves a live role', () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      plantRole(tempDir, 'developer', '# Developer\n')

      expect(staleAgentSkillPaths(tempDir, ['.agents/skills/vinaya-developer/SKILL.md'])).toEqual([])
    })

    it("flags a retired role's skill in both .agents/skills/ and .claude/skills/", () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      plantRole(tempDir, 'developer', '# Developer\n')

      expect(
        staleAgentSkillPaths(tempDir, [
          '.agents/skills/vinaya-developer/SKILL.md',
          '.claude/skills/vinaya-developer/SKILL.md',
          '.agents/skills/vinaya-brief-author/SKILL.md',
          '.claude/skills/vinaya-brief-author/SKILL.md'
        ])
      ).toEqual(['.agents/skills/vinaya-brief-author/SKILL.md', '.claude/skills/vinaya-brief-author/SKILL.md'])
    })

    it('never matches a hand-authored skill beside the generated ones, even when recorded', () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      plantRole(tempDir, 'developer', '# Developer\n')

      const handAuthored = ['.agents/skills/dispatch-vps/SKILL.md', '.claude/skills/dispatch-vps/SKILL.md']
      expect(staleAgentSkillPaths(tempDir, handAuthored)).toEqual([])
      for (const path of handAuthored) expect(isAgentSkillPath(path)).toBe(false)
      expect(isAgentSkillPath('.claude/skills/vinaya-developer/SKILL.md')).toBe(true)
      expect(isAgentSkillPath('.agents/skills/vinaya-developer/SKILL.md')).toBe(true)
    })

    it('ignores paths outside the .agents/skills/vinaya-<role>/SKILL.md shape', () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      plantRole(tempDir, 'developer', '# Developer\n')

      expect(staleAgentSkillPaths(tempDir, ['.claude/commands/vinaya.md', 'AGENTS.md'])).toEqual([])
    })
  })

  describe('buildAgentsSkillsOps & idempotence', () => {
    it('produces create-file ops and guarantees byte-for-byte idempotence', () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      plantRole(tempDir, 'planner', '# Planner\n')
      plantRole(tempDir, 'reviewer', '# Reviewer\n')

      const ops1 = buildAgentsSkillsOps(tempDir)
      const ops2 = buildAgentsSkillsOps(tempDir)

      expect(ops1).toHaveLength(2)
      expect(ops1).toEqual(ops2)
      expect(ops1[0]).toEqual({
        kind: 'create-file',
        path: '.agents/skills/vinaya-planner/SKILL.md',
        content: renderAgentSkill('planner'),
        group: 'Agent skills (.agents/skills/)'
      })
      expect(ops1[1]).toEqual({
        kind: 'create-file',
        path: '.agents/skills/vinaya-reviewer/SKILL.md',
        content: renderAgentSkill('reviewer'),
        group: 'Agent skills (.agents/skills/)'
      })
    })
  })
})

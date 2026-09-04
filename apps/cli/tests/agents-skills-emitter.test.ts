import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentSkillPath,
  buildAgentsSkillsOps,
  discoverRoleNames,
  formatRoleTitle,
  renderAgentSkill
} from '../src/lib/agents-skills-emitter.js'

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
      writeFileSync(join(rolesDir, 'developer.md'), '# Developer\n')
      writeFileSync(join(rolesDir, 'brief-author.md'), '# Brief Author\n')
      writeFileSync(join(rolesDir, 'archivist.md'), '# Archivist\n')
      writeFileSync(join(rolesDir, 'ignored.txt'), 'ignore me\n')

      const roles = discoverRoleNames(tempDir)
      expect(roles).toEqual(['archivist', 'brief-author', 'developer'])
    })

    it('returns empty array if roles directory does not exist', () => {
      expect(discoverRoleNames(join(tempDir, 'nonexistent'))).toEqual([])
    })

    it('excludes actor: human roles (principal), includes agent and either', () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      writeFileSync(join(rolesDir, 'developer.md'), '---\nactor: agent\n---\n# Developer\n')
      writeFileSync(join(rolesDir, 'principal.md'), '---\nactor: human\n---\n# Principal\n')
      writeFileSync(join(rolesDir, 'archivist.md'), '---\nactor: either\n---\n# Archivist\n')

      const roles = discoverRoleNames(tempDir)
      expect(roles).toEqual(['archivist', 'developer'])
      expect(roles).not.toContain('principal')
    })

    it('excludes principal against the real bundled doctrine', () => {
      const realRoot = join(import.meta.dir, '..', '..', '..', 'aeg-root')
      const roles = discoverRoleNames(realRoot)
      expect(roles).not.toContain('principal')
      expect(roles).toContain('developer')
    })
  })

  describe('renderAgentSkill', () => {
    it('matches exact 3-line pointer specification for developer', () => {
      const expected = `---
name: vinaya-developer
description: Act as the AEG Developer for this repo.
---
Run \`vinaya doctrine --role developer\` and follow its output as your operating instructions for this session.
`
      expect(renderAgentSkill('developer')).toBe(expected)
      expect(agentSkillPath('developer')).toBe('.agents/skills/vinaya-developer/SKILL.md')
    })

    it('matches exact 3-line pointer specification for brief-author', () => {
      const expected = `---
name: vinaya-brief-author
description: Act as the AEG Brief Author for this repo.
---
Run \`vinaya doctrine --role brief-author\` and follow its output as your operating instructions for this session.
`
      expect(renderAgentSkill('brief-author')).toBe(expected)
      expect(agentSkillPath('brief-author')).toBe('.agents/skills/vinaya-brief-author/SKILL.md')
    })
  })

  describe('renderAgentSkill — selfHost (atta-labs/vinaya#408)', () => {
    it('invokes the source CLI when selfHost is set', () => {
      const expected = `---
name: vinaya-developer
description: Act as the AEG Developer for this repo.
---
Run \`bun apps/cli/src/index.ts doctrine --role developer\` and follow its output as your operating instructions for this session.
`
      expect(renderAgentSkill('developer', { dir: 'apps/cli', bin: 'apps/cli/dist/index.js' })).toBe(expected)
    })

    it('is unchanged for the ordinary adopter when selfHost is explicitly null', () => {
      expect(renderAgentSkill('developer', null)).toBe(renderAgentSkill('developer'))
    })
  })

  describe('buildAgentsSkillsOps & idempotence', () => {
    it('produces create-file ops and guarantees byte-for-byte idempotence', () => {
      const rolesDir = join(tempDir, 'roles')
      mkdirSync(rolesDir, { recursive: true })
      writeFileSync(join(rolesDir, 'planner.md'), '# Planner\n')
      writeFileSync(join(rolesDir, 'reviewer.md'), '# Reviewer\n')

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

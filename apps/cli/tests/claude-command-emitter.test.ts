import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import {
  CLAUDE_COMMAND_GROUP,
  CLAUDE_COMMAND_PATH,
  buildClaudeCommandOps,
  renderClaudeCommand
} from '../src/lib/claude-command-emitter.js'

const CLI_ENTRY = join(import.meta.dir, '..', 'src', 'index.ts')

describe('claude-command-emitter', () => {
  describe('renderClaudeCommand', () => {
    it('matches the exact frontmatter + $ARGUMENTS body specification', () => {
      const expected = `---
description: Act as an AEG role for this repo.
allowed-tools: Bash(vinaya doctrine *)
---
!\`vinaya doctrine --role $ARGUMENTS\`
`
      expect(renderClaudeCommand()).toBe(expected)
    })

    it('scopes allowed-tools to vinaya doctrine only, so no arbitrary Bash escapes', () => {
      const content = renderClaudeCommand()
      expect(content).toContain('allowed-tools: Bash(vinaya doctrine *)')
    })

    it('uses bare $ARGUMENTS, not an indexed/named form', () => {
      const content = renderClaudeCommand()
      expect(content).toContain('$ARGUMENTS')
      expect(content).not.toMatch(/\$ARGUMENTS\[/)
      expect(content).not.toMatch(/\$1\b/)
    })

    it('is deterministic across calls (no per-invocation state)', () => {
      expect(renderClaudeCommand()).toBe(renderClaudeCommand())
    })
  })

  describe('buildClaudeCommandOps', () => {
    it('produces exactly one create-file op at the documented path', () => {
      const ops = buildClaudeCommandOps()
      expect(ops).toHaveLength(1)
      expect(ops[0]).toEqual({
        kind: 'create-file',
        path: CLAUDE_COMMAND_PATH,
        content: renderClaudeCommand(),
        group: CLAUDE_COMMAND_GROUP
      })
    })

    it('is idempotent — repeated builds are byte-for-byte identical', () => {
      expect(buildClaudeCommandOps()).toEqual(buildClaudeCommandOps())
    })
  })

  describe('CLAUDE_COMMAND_PATH', () => {
    it('is the documented .claude/commands/vinaya.md path', () => {
      expect(CLAUDE_COMMAND_PATH).toBe('.claude/commands/vinaya.md')
    })
  })

  // The load-bearing security property this emitter depends on: `$ARGUMENTS`
  // reaches `vinaya doctrine --role` as a raw, unescaped string (Claude Code
  // does no sanitization of its own — github.com/anthropics/claude-code#16163).
  // This file does not re-implement that validation; it proves the downstream
  // gate (`doctrine.ts`) actually rejects the exact shape of input the
  // generated command would forward unmodified, so a future edit to either
  // file that quietly weakens the gate breaks a test here, not just there.
  describe('downstream role-token validation (the load-bearing trap)', () => {
    it('rejects a role token containing an apostrophe, as $ARGUMENTS would forward it raw', async () => {
      const proc = Bun.spawn(['bun', CLI_ENTRY, 'doctrine', '--role', "developer'; rm -rf /"], {
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const exitCode = await proc.exited
      const stderr = await new Response(proc.stderr).text()

      expect(exitCode).toBe(1)
      expect(stderr).toContain('is not a known role')
    })
  })
})

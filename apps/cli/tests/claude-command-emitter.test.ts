import { describe, expect, it } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
    it('matches the exact frontmatter + double-quoted $ARGUMENTS body specification', () => {
      const expected = `---
description: Act as an AEG role for this repo.
allowed-tools: Bash(vinaya doctrine *)
---
!\`vinaya doctrine --role "$ARGUMENTS"\`
`
      expect(renderClaudeCommand()).toBe(expected)
    })

    it('scopes allowed-tools to vinaya doctrine only, so no arbitrary Bash escapes', () => {
      const content = renderClaudeCommand()
      expect(content).toContain('allowed-tools: Bash(vinaya doctrine *)')
    })

    it('uses bare $ARGUMENTS (not an indexed/named form), double-quoted', () => {
      const content = renderClaudeCommand()
      expect(content).toContain('"$ARGUMENTS"')
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

  // These tests exercise the ACTUAL shell splice a Claude Code `$ARGUMENTS`
  // substitution performs: raw text replacement into the rendered command
  // BEFORE a shell parses it, then that resulting line is handed to a real
  // shell — never `Bun.spawn`'s array form, which sidesteps the shell
  // entirely and would prove nothing about this threat model (that gap in
  // the original version of this test file was the reviewed MEDIUM finding
  // this rewrite fixes). `vinaya doctrine` is invoked via the real CLI entry
  // (`bun <CLI_ENTRY> doctrine`) rather than a globally-installed `vinaya`
  // binary, matching the emitter's own module doc.
  describe('the shell splice — what quoting closes, and what it does not', () => {
    function shellArgSegment(): string {
      const m = renderClaudeCommand().match(/!`vinaya doctrine --role\s+(.+)`/)
      if (!m) throw new Error('renderClaudeCommand() output did not match the expected command shape')
      return m[1] as string
    }

    /** Mirrors Claude Code's own raw pre-shell text splice: replace, don't shell-escape. */
    function spliceArguments(payload: string): string {
      return `bun ${CLI_ENTRY} doctrine --role ${shellArgSegment().replaceAll('$ARGUMENTS', payload)}`
    }

    async function runInRealShell(shellCmd: string): Promise<{ exitCode: number; stderr: string }> {
      const proc = Bun.spawn(['bash', '-c', shellCmd], { stdout: 'pipe', stderr: 'pipe' })
      const exitCode = await proc.exited
      const stderr = await new Response(proc.stderr).text()
      return { exitCode, stderr }
    }

    it("double-quoting neutralizes the cited semicolon/apostrophe class (Issue #16163's own repro shape)", async () => {
      const marker = join(tmpdir(), `vinaya-emitter-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      rmSync(marker, { force: true })
      const shellCmd = spliceArguments(`developer; touch ${marker}`)

      const { exitCode, stderr } = await runInRealShell(shellCmd)

      // The injected `touch` must NEVER run — the whole malicious string
      // lands as ONE argument to `--role`, which doctrine.ts then rejects.
      expect(existsSync(marker)).toBe(false)
      expect(exitCode).toBe(1)
      expect(stderr).toContain('is not a known role')
      rmSync(marker, { force: true })
    })

    it('command substitution is NOT closed by quoting — documented residual gap, not silently assumed safe', async () => {
      const marker = join(tmpdir(), `vinaya-emitter-subst-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      rmSync(marker, { force: true })
      const shellCmd = spliceArguments(`developer$(touch ${marker})`)

      await runInRealShell(shellCmd)

      // This assertion is inverted on purpose: it proves the module doc's
      // own claim (`$(...)` still executes inside double quotes) stays
      // true, so a future change that silently "fixes" the quoting
      // without actually closing this class fails LOUD here instead of
      // shipping a doc that quietly stops matching reality.
      expect(existsSync(marker)).toBe(true)
      rmSync(marker, { force: true })
    })

    it('a quote-breakout payload still executes before any validation, regardless of quote style chosen', async () => {
      const marker = join(tmpdir(), `vinaya-emitter-breakout-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      rmSync(marker, { force: true })
      // Closes the double quote this template opens, runs an injected
      // command, then reopens a matching double quote so the rest of the
      // line still parses — the same class Issue #150 cites, just aimed at
      // whichever quote character the template happens to use.
      const shellCmd = spliceArguments(`developer"; touch ${marker}; ROLE="safe`)

      await runInRealShell(shellCmd)

      expect(existsSync(marker)).toBe(true)
      rmSync(marker, { force: true })
    })
  })
})

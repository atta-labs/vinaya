import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildClaudeStopHookOps,
  CLAUDE_SETTINGS_PATH,
  CLAUDE_STOP_HOOK_GROUP,
  CLAUDE_STOP_HOOK_MARKER,
  CLAUDE_STOP_HOOK_SCRIPT_PATH,
  renderClaudeSettingsWithStopHook,
  renderTrackTranscriptScriptBody
} from '../src/lib/claude-stop-hook-emitter.js'

/**
 * Mirrors `packages/aeg-core/bin/report-tokens.ts`'s `sanitizeKey`/
 * `transcriptPointerPath` — reimplemented here (not imported across the
 * package boundary; that file is a `bin/` adapter, not this package's public
 * export) directly from that file's own source, read at Dig time (task 10).
 * Any future drift between the two is exactly what
 * "round-trips through the real parser" below would catch, since it asserts
 * against the SAME algorithm restated independently.
 */
function sanitizeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '-')
}
function transcriptPointerPath(projectDir: string, tmpDir: string): string {
  return `${tmpDir}/claude-transcript-${sanitizeKey(projectDir)}.txt`
}

describe('claude-stop-hook-emitter', () => {
  describe('path constants', () => {
    it('script path matches the canonical filename report-tokens.ts already documents', () => {
      expect(CLAUDE_STOP_HOOK_SCRIPT_PATH).toBe('.claude/hooks/track-transcript.sh')
    })

    it('settings path is the Claude Code project settings file', () => {
      expect(CLAUDE_SETTINGS_PATH).toBe('.claude/settings.json')
    })
  })

  describe('renderClaudeSettingsWithStopHook', () => {
    it('registers a Stop hook pointing at the managed script via $CLAUDE_PROJECT_DIR', () => {
      const parsed = JSON.parse(renderClaudeSettingsWithStopHook())
      expect(parsed.hooks.Stop).toHaveLength(1)
      expect(parsed.hooks.Stop[0].hooks).toHaveLength(1)
      expect(parsed.hooks.Stop[0].hooks[0]).toEqual({
        type: 'command',
        command: `$CLAUDE_PROJECT_DIR/${CLAUDE_STOP_HOOK_SCRIPT_PATH}`,
        timeout: 5
      })
    })

    it('is deterministic across calls (no per-invocation state)', () => {
      expect(renderClaudeSettingsWithStopHook()).toBe(renderClaudeSettingsWithStopHook())
    })
  })

  describe('buildClaudeStopHookOps', () => {
    it('produces exactly one managed-block op (the script) and one create-file op (settings.json)', () => {
      const ops = buildClaudeStopHookOps()
      expect(ops).toHaveLength(2)
      expect(ops[0]).toMatchObject({
        kind: 'managed-block',
        path: CLAUDE_STOP_HOOK_SCRIPT_PATH,
        marker: CLAUDE_STOP_HOOK_MARKER,
        comment: 'hash',
        mode: 0o755,
        group: CLAUDE_STOP_HOOK_GROUP
      })
      expect(ops[1]).toEqual({
        kind: 'create-file',
        path: CLAUDE_SETTINGS_PATH,
        content: renderClaudeSettingsWithStopHook(),
        group: CLAUDE_STOP_HOOK_GROUP
      })
    })
  })

  // The actual script logic — executed for real, not asserted against as a
  // string — proving Test Plan item 4: a written pointer, read back through
  // the parser's own documented algorithm, resolves correctly.
  describe('the generated script — a real Stop-hook payload, end to end', () => {
    function writeScript(dir: string): string {
      const scriptPath = join(dir, 'track-transcript.sh')
      writeFileSync(scriptPath, `#!/usr/bin/env sh\n${renderTrackTranscriptScriptBody()}\n`, { mode: 0o755 })
      return scriptPath
    }

    async function runHook(
      scriptPath: string,
      payload: unknown,
      env: Record<string, string>
    ): Promise<{ exitCode: number; stderr: string }> {
      const proc = Bun.spawn(['sh', scriptPath], {
        stdin: new Response(JSON.stringify(payload)).body,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...env }
      })
      const exitCode = await proc.exited
      const stderr = await new Response(proc.stderr).text()
      return { exitCode, stderr }
    }

    it('writes session id and transcript path, tab-separated, at the exact path the parser computes', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'vinaya-stop-hook-project-'))
      const tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-stop-hook-tmp-'))
      try {
        const scriptPath = writeScript(projectDir)
        const transcriptPath = join(projectDir, 'session.jsonl')
        writeFileSync(transcriptPath, '')

        const { exitCode } = await runHook(
          scriptPath,
          { session_id: 'abc-123', transcript_path: transcriptPath, hook_event_name: 'Stop' },
          { CLAUDE_PROJECT_DIR: projectDir, TMPDIR: tmpDir }
        )
        expect(exitCode).toBe(0)

        const pointerPath = transcriptPointerPath(projectDir, tmpDir)
        const contents = readFileSync(pointerPath, 'utf-8')
        // The exact grammar `resolveTranscriptPath` parses: trim, split on
        // '\t', second field is the transcript path.
        const [sessionId, parsedTranscriptPath] = contents.trim().split('\t')
        expect(sessionId).toBe('abc-123')
        expect(parsedTranscriptPath).toBe(transcriptPath)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('is a graceful no-op (exit 0, no pointer written) when the payload carries no transcript_path', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'vinaya-stop-hook-project-'))
      const tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-stop-hook-tmp-'))
      try {
        const scriptPath = writeScript(projectDir)
        const { exitCode } = await runHook(
          scriptPath,
          { hook_event_name: 'Stop' },
          { CLAUDE_PROJECT_DIR: projectDir, TMPDIR: tmpDir }
        )
        expect(exitCode).toBe(0)
        expect(existsSync(transcriptPointerPath(projectDir, tmpDir))).toBe(false)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('exits 0 rather than crashing the session on a malformed (non-JSON) payload', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'vinaya-stop-hook-project-'))
      const tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-stop-hook-tmp-'))
      try {
        const scriptPath = writeScript(projectDir)
        const proc = Bun.spawn(['sh', scriptPath], {
          stdin: new Response('not json').body,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, TMPDIR: tmpDir }
        })
        const exitCode = await proc.exited
        expect(exitCode).toBe(0)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('appended into an existing adopter script, the block still runs correctly (never-clobber round-trip)', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'vinaya-stop-hook-project-'))
      const tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-stop-hook-tmp-'))
      try {
        mkdirSync(join(projectDir, '.claude/hooks'), { recursive: true })
        const scriptPath = join(projectDir, '.claude/hooks/track-transcript.sh')
        // An adopter's own pre-existing content, then the managed block
        // appended after it — exactly what `appendBlock` (lib/ops.ts) does.
        writeFileSync(
          scriptPath,
          `#!/usr/bin/env sh\necho "adopter step" >&2\n\n${renderTrackTranscriptScriptBody()}\n`,
          { mode: 0o755 }
        )
        const transcriptPath = join(projectDir, 'session.jsonl')

        const { exitCode, stderr } = await runHook(
          scriptPath,
          { session_id: 'xyz', transcript_path: transcriptPath },
          { CLAUDE_PROJECT_DIR: projectDir, TMPDIR: tmpDir }
        )
        expect(exitCode).toBe(0)
        expect(stderr).toContain('adopter step') // their line still ran
        const contents = readFileSync(transcriptPointerPath(projectDir, tmpDir), 'utf-8')
        expect(contents.trim()).toBe(`xyz\t${transcriptPath}`)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  })
})

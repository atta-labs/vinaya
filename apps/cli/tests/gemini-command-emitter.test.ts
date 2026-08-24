import { describe, expect, it } from 'bun:test'
import {
  buildGeminiCommandOp,
  GEMINI_COMMAND_GROUP,
  GEMINI_COMMAND_PATH,
  renderGeminiCommand
} from '../src/lib/gemini-command-emitter.js'

describe('gemini-command-emitter', () => {
  describe('renderGeminiCommand', () => {
    it('matches the exact parameterized TOML specification', () => {
      const expected = `description = "Act as an AEG role for this repo."
prompt = "!{vinaya doctrine --role {{args}}}"
`
      expect(renderGeminiCommand()).toBe(expected)
    })

    it('produces valid TOML with balanced braces in the shell-injection block', () => {
      const content = renderGeminiCommand()
      const opens = (content.match(/\{/g) ?? []).length
      const closes = (content.match(/\}/g) ?? []).length
      expect(opens).toBe(closes)
    })

    it('never claims silent or automatic execution', () => {
      const content = renderGeminiCommand().toLowerCase()
      expect(content).not.toContain('automatic')
      expect(content).not.toContain('silent')
      expect(content).not.toContain('no confirmation')
    })
  })

  describe('buildGeminiCommandOp & idempotence', () => {
    it('produces a single create-file op targeting .gemini/commands/vinaya.toml', () => {
      const op1 = buildGeminiCommandOp()
      const op2 = buildGeminiCommandOp()

      expect(op1).toEqual(op2)
      expect(op1).toEqual({
        kind: 'create-file',
        path: '.gemini/commands/vinaya.toml',
        content: renderGeminiCommand(),
        group: GEMINI_COMMAND_GROUP
      })
      expect(GEMINI_COMMAND_PATH).toBe('.gemini/commands/vinaya.toml')
    })
  })
})

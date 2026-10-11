import { describe, expect, it } from 'bun:test'
import matter from 'gray-matter'
import { AGENT_VENDORS } from '../../src/lib/agent-vendors'
import { buildInitOps, DOCTRINE_POINTER_PATHS, type InitContext } from '../../src/lib/artifacts'
import type { CreateFileOp, Op } from '../../src/lib/ops'

/**
 * Every agent-facing file the generator writes sits where its vendor's own
 * documentation says that vendor reads it, and carries only the frontmatter
 * fields that vendor documents. The files are read from the generator's own
 * op list — the doctrine pointers plus every op an agent vendor adds — never
 * from a list kept here, so a file added later is checked the day it lands.
 *
 * Sources:
 * - Claude Code memory, skills, commands, hooks, settings, MCP:
 *   code.claude.com/docs/en/memory, /skills, /slash-commands, /hooks,
 *   /settings, /mcp
 * - Codex `AGENTS.md` and skills (`name` and `description` only):
 *   developers.openai.com/codex/guides/agents-md, /codex/skills
 * - Gemini CLI custom commands (TOML) and settings:
 *   github.com/google-gemini/gemini-cli docs/cli/custom-commands.md,
 *   docs/get-started/configuration.md
 */

type Format =
  | { readonly kind: 'markdown'; readonly frontmatter: readonly string[] }
  | { readonly kind: 'toml'; readonly keys: readonly string[] }
  | { readonly kind: 'json' }
  | { readonly kind: 'script' }

type VendorLocation = { readonly vendor: string; readonly what: string; readonly path: RegExp; readonly format: Format }

const CLAUDE_SKILL_FIELDS = [
  'name',
  'description',
  'allowed-tools',
  'argument-hint',
  'disable-model-invocation',
  'user-invocable',
  'model',
  'context',
  'agent',
  'hooks'
] as const
const CLAUDE_COMMAND_FIELDS = ['description', 'allowed-tools', 'argument-hint', 'model', 'disable-model-invocation']

const VENDOR_LOCATIONS: readonly VendorLocation[] = [
  {
    vendor: 'Codex',
    what: 'project memory',
    path: /^AGENTS\.md$/,
    format: { kind: 'markdown', frontmatter: [] }
  },
  {
    vendor: 'Claude Code',
    what: 'project memory',
    path: /^CLAUDE\.md$/,
    format: { kind: 'markdown', frontmatter: [] }
  },
  {
    vendor: 'Claude Code',
    what: 'command',
    path: /^\.claude\/commands\/[^/]+\.md$/,
    format: { kind: 'markdown', frontmatter: CLAUDE_COMMAND_FIELDS }
  },
  {
    vendor: 'Claude Code',
    what: 'skill',
    path: /^\.claude\/skills\/[^/]+\/SKILL\.md$/,
    format: { kind: 'markdown', frontmatter: CLAUDE_SKILL_FIELDS }
  },
  {
    vendor: 'Claude Code',
    what: 'hook script',
    path: /^\.claude\/hooks\/[^/]+\.sh$/,
    format: { kind: 'script' }
  },
  { vendor: 'Claude Code', what: 'project settings', path: /^\.claude\/settings\.json$/, format: { kind: 'json' } },
  { vendor: 'Claude Code', what: 'project MCP servers', path: /^\.mcp\.json$/, format: { kind: 'json' } },
  {
    vendor: 'Codex',
    what: 'portable skill',
    path: /^\.agents\/skills\/[^/]+\/SKILL\.md$/,
    format: { kind: 'markdown', frontmatter: ['name', 'description'] }
  },
  {
    vendor: 'Gemini CLI',
    what: 'command',
    path: /^\.gemini\/commands\/[^/]+\.toml$/,
    format: { kind: 'toml', keys: ['description', 'prompt'] }
  },
  { vendor: 'Gemini CLI', what: 'project settings', path: /^\.gemini\/settings\.json$/, format: { kind: 'json' } }
]

function createFileOps(ops: readonly Op[]): CreateFileOp[] {
  return ops.filter((op): op is CreateFileOp => op.kind === 'create-file')
}

function initOps(agents: InitContext['agents']): Op[] {
  return buildInitOps({ owner: 'o', repo: 'r', hookDir: '.husky', selfHost: null, ciSetup: null, agents })
}

/** The doctrine pointers, plus every file the generator writes only because an agent vendor is selected. */
function agentFacingOps(): CreateFileOp[] {
  const withoutAgents = new Set(createFileOps(initOps(new Set())).map((op) => op.path))
  return createFileOps(initOps(new Set(AGENT_VENDORS))).filter(
    (op) => DOCTRINE_POINTER_PATHS.includes(op.path) || !withoutAgents.has(op.path)
  )
}

function formatViolation(op: CreateFileOp, location: VendorLocation): string | null {
  const format = location.format
  const where = `${op.path} (${location.vendor} ${location.what})`
  if (format.kind === 'markdown') {
    const fields = Object.keys(matter(op.content).data)
    const undocumented = fields.filter((field) => !format.frontmatter.includes(field))
    return undocumented.length === 0
      ? null
      : `${where} carries frontmatter ${location.vendor} does not document: ${undocumented.join(', ')}`
  }
  if (format.kind === 'toml') {
    let keys: string[]
    try {
      keys = Object.keys(Bun.TOML.parse(op.content) as Record<string, unknown>)
    } catch (err) {
      return `${where} is not TOML: ${(err as Error).message}`
    }
    const undocumented = keys.filter((key) => !format.keys.includes(key))
    return undocumented.length === 0
      ? null
      : `${where} carries keys ${location.vendor} does not document: ${undocumented.join(', ')}`
  }
  if (format.kind === 'json') {
    try {
      JSON.parse(op.content)
      return null
    } catch (err) {
      return `${where} is not JSON: ${(err as Error).message}`
    }
  }
  return null
}

/** One line per file that sits nowhere its vendor reads, or carries a field its vendor does not document. */
function agentFileViolations(ops: readonly CreateFileOp[]): string[] {
  const violations: string[] = []
  for (const op of ops) {
    const location = VENDOR_LOCATIONS.find((candidate) => candidate.path.test(op.path))
    if (location === undefined) {
      violations.push(`${op.path} sits at no path an agent vendor documents reading`)
      continue
    }
    const violation = formatViolation(op, location)
    if (violation !== null) violations.push(violation)
  }
  return violations
}

describe('every agent-facing file the generator writes', () => {
  const ops = agentFacingOps()

  it('reads a non-empty op list that covers every vendor location kind the brief names', () => {
    const paths = ops.map((op) => op.path)
    expect(paths).toContain('AGENTS.md')
    expect(paths).toContain('CLAUDE.md')
    expect(paths.some((p) => p.startsWith('.claude/commands/'))).toBe(true)
    expect(paths.some((p) => p.startsWith('.claude/skills/'))).toBe(true)
    expect(paths.some((p) => p.startsWith('.agents/skills/'))).toBe(true)
    expect(paths.some((p) => p.startsWith('.gemini/commands/'))).toBe(true)
  })

  it("sits at its vendor's documented path and carries only its vendor's documented fields", () => {
    expect(agentFileViolations(ops)).toEqual([])
  })
})

describe('the conformance check refuses', () => {
  const ops = agentFacingOps()
  const portableSkill = ops.find((op) => op.path.startsWith('.agents/skills/'))
  if (portableSkill === undefined) throw new Error('the generator wrote no portable role skills')

  it('a role skill moved to a directory no vendor reads', () => {
    const misplaced = { ...portableSkill, path: portableSkill.path.replace(/^\.agents\/skills\//, '.codex/skills/') }
    expect(agentFileViolations([misplaced])).toEqual([
      `${misplaced.path} sits at no path an agent vendor documents reading`
    ])
  })

  it('a Claude-only field leaked into a portable skill Codex reads', () => {
    const leaked = {
      ...portableSkill,
      content: portableSkill.content.replace(/^description: .*$/m, (line) => `${line}\nallowed-tools: Bash(ls)`)
    }
    expect(agentFileViolations([leaked])).toEqual([
      `${leaked.path} (Codex portable skill) carries frontmatter Codex does not document: allowed-tools`
    ])
  })

  it('a Gemini command that is not TOML', () => {
    const command = ops.find((op) => op.path.startsWith('.gemini/commands/'))
    if (command === undefined) throw new Error('the generator wrote no Gemini command')
    expect(agentFileViolations([{ ...command, content: '---\nname: x\n---\n' }])[0]).toStartWith(
      `${command.path} (Gemini CLI command) is not TOML`
    )
  })

  it('never the Claude-only field in the Claude skill the generator grants it to', () => {
    const granted = ops.filter((op) => op.path.startsWith('.claude/skills/') && /^allowed-tools: /m.test(op.content))
    expect(granted.length).toBeGreaterThan(0)
    expect(agentFileViolations(granted)).toEqual([])
  })
})

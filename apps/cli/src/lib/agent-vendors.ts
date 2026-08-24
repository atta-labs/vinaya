// The vendor keys `vinaya init --agents` selects among — one per
// agent-native entry point (tasks 2/3/4: `.agents/skills/`, `.claude/commands/`,
// `.gemini/commands/`), wired into the install lifecycle by task 5 (#152).
//
// A single source so `artifacts.ts` (op generation), `config.ts` (the
// persisted `managed.agents` selection), and every command that reads or
// writes it agree on the same three names and the same order.
export const AGENT_VENDORS = ['skills', 'claude', 'gemini'] as const
export type AgentVendor = (typeof AGENT_VENDORS)[number]

export function isAgentVendor(value: string): value is AgentVendor {
  return (AGENT_VENDORS as readonly string[]).includes(value)
}

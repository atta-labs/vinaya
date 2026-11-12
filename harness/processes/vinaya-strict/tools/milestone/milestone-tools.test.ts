import { expect, it } from 'bun:test'
import { milestoneToolHandlers, type SharedMilestoneOperations } from './milestone-tools'

it('status and close preserve library outcomes and pass validated input', async () => {
  const status = { ok: true as const, milestone: { number: 7, title: 'Goal', state: 'open' as const }, tranches: [] }
  const close = { ok: true as const, written: false as const, number: 7, title: 'Goal' }
  const seen: unknown[] = []
  const ops: SharedMilestoneOperations = {
    milestoneStatus: async (v) => {
      seen.push(v)
      return status
    },
    closeMilestone: async (v) => {
      seen.push(v)
      return close
    }
  }
  const handlers = milestoneToolHandlers(ops)
  expect(await handlers.milestone_status({ number: '7' }, null)).toEqual({ ok: true, result: status })
  expect(await handlers.milestone_close({ slug: 'slice', validateOnly: true }, null)).toEqual({
    ok: true,
    result: close
  })
  expect(seen).toEqual([{ number: '7' }, { slug: 'slice', validateOnly: true }])
})

it('preserves every finding and catches failures without ending the server', async () => {
  const findings = [1, 2].map((n) => ({
    schema: 1 as const,
    severity: 'error' as const,
    check: `gate-${n}`,
    message: `finding ${n}`,
    agent_recovery_prompt: `repair ${n}`
  }))
  const handlers = milestoneToolHandlers({
    milestoneStatus: async () => ({ ok: false, findings }),
    closeMilestone: async () => {
      throw new Error('unreachable')
    }
  })
  const result = await handlers.milestone_status({ number: '7' }, null)
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error.kind).toBe('validation')
    expect(JSON.parse(result.error.detail ?? '[]')).toEqual(
      findings.map((e) => ({ check: e.check, message: e.message, recovery: e.agent_recovery_prompt }))
    )
  }
  expect((await handlers.milestone_close({ slug: 'slice' }, null)).ok).toBe(false)
})

it('refuses malformed input before calling the library', async () => {
  const fail = async (): Promise<never> => {
    throw new Error('must not run')
  }
  const handlers = milestoneToolHandlers({ milestoneStatus: fail, closeMilestone: fail })
  for (const [name, input] of [
    ['milestone_status', { number: '../7' }],
    ['milestone_close', { slug: 'x', extra: true }]
  ] as const) {
    const result = await handlers[name](input, null)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')
  }
})

import { expect, it } from 'bun:test'
import { architectToolHandlers, type ArchitectOperations } from './architect-tools'
import { deleteMilestone, realMilestoneForge, type MilestoneForge } from '../../../tools/milestone/milestone-operations'

it('each Architect tool passes input to its library operation and preserves the outcome', async () => {
  const seen: unknown[] = []
  const written = { ok: true as const, written: true as const, number: 7, url: 'https://example.test/7' }
  const adopted = { ok: true as const, written: true as const, target: 'Goal', adopted: [] }
  const deleted = { ok: true as const, deleted: true as const, number: 7 }
  const ops: ArchitectOperations = {
    createMilestone: async (v) => {
      seen.push(v)
      return written
    },
    editMilestone: async (v) => {
      seen.push(v)
      return written
    },
    adoptMilestone: async (v) => {
      seen.push(v)
      return adopted
    },
    deleteMilestone: async (v) => {
      seen.push(v)
      return deleted
    }
  }
  const h = architectToolHandlers(ops)
  expect(await h.milestone_create({ title: 'Goal', body: 'Prose' }, null)).toEqual({ ok: true, result: written })
  expect(await h.milestone_edit({ number: '7', body: 'New prose', validateOnly: true }, null)).toEqual({
    ok: true,
    result: written
  })
  expect(await h.milestone_adopt({ target: 'Goal', slugs: ['slice'] }, null)).toEqual({ ok: true, result: adopted })
  expect(await h.milestone_delete({ number: '7' }, null)).toEqual({ ok: true, result: deleted })
  expect(seen).toEqual([
    { title: 'Goal', body: 'Prose', validateOnly: false },
    { number: '7', body: 'New prose', validateOnly: true },
    { target: 'Goal', slugs: ['slice'], validateOnly: false },
    { number: '7' }
  ])
})

for (const mode of ['missing', 'attached', 'empty'] as const) {
  it(`delete matches the real library for an ${mode} Milestone`, async () => {
    const writes: string[][] = []
    const forge: MilestoneForge = {
      ...realMilestoneForge,
      resolveRepo: async () => ({ owner: 'o', repo: 'r' }),
      sh: (args) => {
        if (args.includes('DELETE')) {
          writes.push(args)
          return ''
        }
        if (args.includes('--paginate'))
          return JSON.stringify(
            mode === 'attached'
              ? [
                  { number: 11, title: 'Issue', state: 'closed' },
                  { number: 12, title: 'PR', state: 'open', pull_request: {} }
                ]
              : []
          )
        if (mode === 'missing') throw new Error('HTTP 404 Not Found')
        return JSON.stringify({
          number: 7,
          open_issues: mode === 'attached' ? 1 : 0,
          closed_issues: mode === 'attached' ? 1 : 0
        })
      }
    }
    const expected = await deleteMilestone({ number: '7' }, forge)
    const result = await architectToolHandlers({
      createMilestone: async () => {
        throw new Error('unused')
      },
      editMilestone: async () => {
        throw new Error('unused')
      },
      adoptMilestone: async () => {
        throw new Error('unused')
      },
      deleteMilestone: (v) => deleteMilestone(v, forge)
    }).milestone_delete({ number: '7' }, null)
    if (expected.ok) expect(result).toEqual({ ok: true, result: expected })
    else {
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(JSON.parse(result.error.detail ?? '[]')).toEqual(
          expected.findings.map((e) => ({ check: e.check, message: e.message, recovery: e.agent_recovery_prompt }))
        )
        if (mode === 'attached') {
          expect(result.error.message).toContain('#11 (issue, closed) Issue')
          expect(result.error.message).toContain('#12 (pull request, open) PR')
        } else expect(result.error.message).toContain('does not exist')
      }
    }
    expect(writes.length).toBe(mode === 'empty' ? 2 : 0)
  })
}

it('rejects extra deletion arguments before effects', async () => {
  const result = await architectToolHandlers().milestone_delete({ number: '7', force: true }, null)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.kind).toBe('validation')
})

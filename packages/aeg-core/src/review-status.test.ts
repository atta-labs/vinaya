import { describe, expect, it } from 'vitest'
import { deriveReviewStatus, parseDeveloperRoundMarker, renderReviewStatus } from './review-status'

const ALLOWLIST = ['daniboomerang']
const HEAD = 'abc1234def5678901234567890abcdef12345678'
const OLD_HEAD = '9999999888888887777777766666665555555544'

/**
 * Verdict comments are rendered exactly as `review-post.ts` writes them:
 * `VERDICT:` on line 1, `Judged head:` on line 3, findings below. Every
 * fixture here is that shape, so these tests exercise the same text the
 * merge gate reads, not a paraphrase of it.
 */
function verdict(head: string, findings: string[] = [], value = 'REQUEST CHANGES'): string {
  return [`VERDICT: ${value}`, '', `Judged head: ${head}`, '', 'FINDINGS:', ...findings].join('\n')
}

function finding(n: number, state: string | null, severity = 'MAJOR'): string {
  const stateText = state === null ? '' : ` ${state}`
  return `${n}. [${severity}] apps/cli/src/x.ts:10 — F${n} correctness${stateText}: something is off`
}

function roundComment(n: number): { body: string; author: string } {
  return { body: `Head: ${HEAD}\n\n<!-- aeg:developer:round-${n} -->\n\nAll green.`, author: 'daniboomerang' }
}

function principal(body: string): { body: string; author: string } {
  return { body, author: 'daniboomerang' }
}

describe('parseDeveloperRoundMarker', () => {
  it('reads the round number from the marker', () => {
    expect(parseDeveloperRoundMarker('Head: abc\n\n<!-- aeg:developer:round-2 -->')).toBe(2)
  })

  it('tolerates the whitespace variants an HTML comment can carry', () => {
    expect(parseDeveloperRoundMarker('<!--aeg:developer:round-11-->')).toBe(11)
  })

  it('returns null for a comment carrying no marker — never a guessed round', () => {
    expect(parseDeveloperRoundMarker('Head: abc1234\n\nRan everything, all green.')).toBeNull()
  })
})

describe('deriveReviewStatus — CONTINUE', () => {
  it('CONTINUEs when the only round judged the current head', () => {
    const status = deriveReviewStatus({
      comments: [principal(verdict(HEAD, [finding(1, null)]))],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 3
    })
    expect(status).toEqual({ state: 'CONTINUE' })
  })

  it('CONTINUEs on a PR with no verdict at all — round one has not happened yet', () => {
    const status = deriveReviewStatus({
      comments: [roundComment(1)],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 3
    })
    expect(status).toEqual({ state: 'CONTINUE' })
  })

  it('CONTINUEs when a round killed something it inherited', () => {
    const status = deriveReviewStatus({
      comments: [
        principal(verdict(OLD_HEAD, [finding(1, null), finding(2, null)])),
        roundComment(1),
        principal(verdict(HEAD, [finding(1, 'resolved'), finding(3, null)]))
      ],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 3
    })
    expect(status).toEqual({ state: 'CONTINUE' })
  })

  it('ignores a verdict-shaped comment from a non-allowlisted author', () => {
    const status = deriveReviewStatus({
      comments: [
        { body: verdict(OLD_HEAD, [finding(1, 'resolved')]), author: 'drive-by-stranger' },
        { body: verdict(OLD_HEAD, [finding(1, 'reproduced')]), author: null }
      ],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 3
    })
    expect(status).toEqual({ state: 'CONTINUE' })
  })
})

describe('deriveReviewStatus — PAUSE: reappearance', () => {
  it('PAUSEs naming the id a later round reproduced after calling it resolved', () => {
    const status = deriveReviewStatus({
      comments: [
        principal(verdict(OLD_HEAD, [finding(1, 'resolved')])),
        roundComment(1),
        principal(verdict(HEAD, [finding(1, 'reproduced')]))
      ],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 3
    })
    expect(status).toEqual({ state: 'PAUSE', reason: 'reappearance', id: 'F1', round: 2 })
  })
})

describe('deriveReviewStatus — PAUSE: zero-deaths', () => {
  it('PAUSEs on a round that resolves nothing it inherited and still raises something new', () => {
    const status = deriveReviewStatus({
      comments: [
        principal(verdict(OLD_HEAD, [finding(1, null), finding(2, null)])),
        roundComment(1),
        principal(verdict(HEAD, [finding(1, 'open'), finding(3, null)]))
      ],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 3
    })
    expect(status).toEqual({ state: 'PAUSE', reason: 'zero-deaths', round: 2 })
  })

  it('never fires on round one, which inherits nothing to kill', () => {
    const status = deriveReviewStatus({
      comments: [principal(verdict(HEAD, [finding(1, null), finding(2, null)]))],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 3
    })
    expect(status).toEqual({ state: 'CONTINUE' })
  })
})

describe('deriveReviewStatus — PAUSE: stale', () => {
  it('PAUSEs when the newest verdict judged a superseded head and no Developer round comment followed', () => {
    const status = deriveReviewStatus({
      comments: [principal(verdict(OLD_HEAD, [finding(1, null)]))],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 3
    })
    expect(status).toEqual({ state: 'PAUSE', reason: 'stale', round: 1 })
  })

  it('does not PAUSE when a Developer round comment landed after that verdict', () => {
    const status = deriveReviewStatus({
      comments: [principal(verdict(OLD_HEAD, [finding(1, null)])), roundComment(2)],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 3
    })
    expect(status).toEqual({ state: 'CONTINUE' })
  })

  it("does NOT let a non-allowlisted commenter's round marker clear the stale pause", () => {
    const status = deriveReviewStatus({
      comments: [
        principal(verdict(OLD_HEAD, [finding(1, null)])),
        { body: `Head: ${HEAD}\n\n<!-- aeg:developer:round-2 -->`, author: 'drive-by-stranger' }
      ],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 3
    })
    expect(status).toEqual({ state: 'PAUSE', reason: 'stale', round: 1 })
  })

  it('accepts the abbreviated Judged head form as bound to the full head sha', () => {
    const status = deriveReviewStatus({
      comments: [principal(verdict(HEAD.slice(0, 7), [finding(1, null)]))],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 3
    })
    expect(status).toEqual({ state: 'CONTINUE' })
  })
})

describe('deriveReviewStatus — PAUSE: max-rounds', () => {
  it('PAUSEs once the round count reaches maxRounds', () => {
    const status = deriveReviewStatus({
      comments: [
        principal(verdict('1111111', [finding(1, null)])),
        roundComment(1),
        principal(verdict('2222222', [finding(1, 'resolved'), finding(2, null)])),
        roundComment(2),
        principal(verdict(HEAD, [finding(2, 'resolved')]))
      ],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 3
    })
    expect(status).toEqual({ state: 'PAUSE', reason: 'max-rounds', round: 3 })
  })

  it('groups a code-review and a security verdict on the same judged head as ONE round', () => {
    const status = deriveReviewStatus({
      comments: [principal(verdict(HEAD, [finding(1, null)], 'REQUEST CHANGES')), principal(verdict(HEAD, [], 'FAIL'))],
      headSha: HEAD,
      principalAllowlist: ALLOWLIST,
      maxRounds: 2
    })
    expect(status).toEqual({ state: 'CONTINUE' })
  })
})

describe('renderReviewStatus', () => {
  it('renders CONTINUE bare', () => {
    expect(renderReviewStatus({ state: 'CONTINUE' })).toBe('CONTINUE')
  })

  it('renders a reason-only PAUSE', () => {
    expect(renderReviewStatus({ state: 'PAUSE', reason: 'max-rounds', round: 3 })).toBe('PAUSE: max-rounds')
  })

  it('renders the finding id when the reason names one', () => {
    expect(renderReviewStatus({ state: 'PAUSE', reason: 'reappearance', id: 'F1', round: 2 })).toBe(
      'PAUSE: reappearance F1'
    )
  })

  it('renders `stale` as the actionable push-after-verdict fact, not the bare reason word', () => {
    expect(renderReviewStatus({ state: 'PAUSE', reason: 'stale', round: 1 })).toBe(
      'push after verdict — re-review or refreeze required'
    )
  })
})

// `ci.yml` ends its build job and both sandbox jobs with a step that prints
// the limit headers of two GitHub reads on one `vinaya-limits:` line, so a
// refused read shows which limit refused it. The line must stay invisible to
// the review loop's rate-limit reading.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { parse } from 'yaml'
import { isRateLimitedJobLog } from '../src/lib/dev-review-loop/round-assess'

const CI_PATH = join(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'ci.yml')
const STEP_NAME = "Print the limits of this job's GitHub reads"
const LOOP_WORDING = /api rate limit (?:already )?exceeded|secondary rate limit|rate limit exceeded/i

type Step = { name?: string; if?: string; env?: Record<string, string>; run?: string }
type Workflow = { jobs: Record<string, { steps: Step[] }> }

const workflow = parse(readFileSync(CI_PATH, 'utf8')) as Workflow

function limitsSteps(job: string): Step[] {
  return workflow.jobs[job]!.steps.filter((step) => step.name === STEP_NAME)
}

const limitsStep = limitsSteps('build')[0]!
const script = limitsStep.run!

describe('the limits step in ci.yml', () => {
  it('ends build unless cancelled and both sandbox jobs on failure', () => {
    const expected: Record<string, string> = {
      build: '$' + '{{ !cancelled() }}',
      'sandbox-conformance': 'failure()',
      'sandbox-conformance-macos': 'failure()'
    }
    for (const [job, condition] of Object.entries(expected)) {
      const steps = workflow.jobs[job]!.steps
      expect(limitsSteps(job)).toHaveLength(1)
      expect(steps.at(-1)!.name).toBe(STEP_NAME)
      expect(steps.at(-1)!.if).toBe(condition)
      expect(steps.at(-1)!.run).toBe(script)
    }
  })

  it('holds only GH_TOKEN from the built-in token', () => {
    for (const job of ['build', 'sandbox-conformance', 'sandbox-conformance-macos']) {
      expect(limitsSteps(job)[0]!.env).toEqual({ GH_TOKEN: '$' + '{{ secrets.GITHUB_TOKEN }}' })
    }
  })

  it('is in no other job, the anchor-probe job included', () => {
    const holders = Object.keys(workflow.jobs).filter((job) => limitsSteps(job).length > 0)
    expect(holders.sort()).toEqual(['build', 'sandbox-conformance', 'sandbox-conformance-macos'])
    expect(workflow.jobs['test-cli-config-anchor']).toBeDefined()
  })

  it('does not reuse the budget prefix or the loop wording in its script', () => {
    expect(script).not.toContain('vinaya-budget:')
    expect(LOOP_WORDING.test(script)).toBe(false)
    expect(script).not.toContain('rate_limit')
  })
})

const HEADERS = (limit: string, used: string, remaining: string, extra = '') =>
  `X-Ratelimit-Limit: ${limit}\nX-Ratelimit-Remaining: ${remaining}\nX-Ratelimit-Reset: 1790000000\nX-Ratelimit-Resource: graphql\nX-Ratelimit-Used: ${used}\n${extra}`

const FAKE_GH = `#!/bin/bash
case "$*" in
  *graphql*) kind=graphql ;;
  *) kind=rest ;;
esac
case "$FAKE_CASE:$kind" in
  ok:graphql)
    printf 'HTTP/2.0 200 OK\\r\\n%s\\r\\n\\r\\n{"data":{"rateLimit":{"limit":1000}}}\\n' "$GQL_HEADERS" ;;
  ok:rest)
    printf 'HTTP/2.0 200 OK\\r\\n%s\\r\\n\\r\\n{"id":1}\\n' "$REST_HEADERS" ;;
  graphql-refused:graphql)
    printf 'HTTP/2.0 200 OK\\r\\n%s\\r\\n\\r\\n{"errors":[{"type":"RATE_LIMITED","message":"WORDING"}]}\\n' "$GQL_HEADERS"
    echo "GraphQL: API rate limit already exceeded for user ID 1" >&2
    exit 1 ;;
  graphql-refused:rest)
    printf 'HTTP/2.0 200 OK\\r\\n%s\\r\\n\\r\\n{"id":1}\\n' "$REST_HEADERS" ;;
  rest-refused:graphql)
    printf 'HTTP/2.0 200 OK\\r\\n%s\\r\\n\\r\\n{"data":{}}\\n' "$GQL_HEADERS" ;;
  rest-refused:rest)
    printf 'HTTP/2.0 403 Forbidden\\r\\n%s\\r\\n\\r\\n{"message":"WORDING"}\\n' "$REST_HEADERS"
    echo "gh: API rate limit exceeded (HTTP 403)" >&2
    exit 1 ;;
  retry:graphql)
    printf 'HTTP/2.0 403 Forbidden\\r\\n%s\\r\\n\\r\\n{"errors":[{"type":"OTHER_KIND","message":"WORDING"}]}\\n' "$GQL_HEADERS"
    echo "You have exceeded a secondary rate limit" >&2
    exit 1 ;;
  retry:rest)
    printf 'HTTP/2.0 403 Forbidden\\r\\n%s\\r\\n\\r\\n{"message":"WORDING"}\\n' "$REST_HEADERS"
    echo "You have exceeded a secondary rate limit" >&2
    exit 1 ;;
esac
`

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function runStep(fakeCase: string, gql: string, rest: string): { output: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-limits-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'gh'), FAKE_GH)
  chmodSync(join(dir, 'gh'), 0o755)
  writeFileSync(join(dir, 'step.sh'), script)
  const result = Bun.spawnSync(['bash', '-e', join(dir, 'step.sh')], {
    env: {
      PATH: `${dir}:/usr/bin:/bin`,
      GITHUB_REPOSITORY: 'owner/repo',
      FAKE_CASE: fakeCase,
      GQL_HEADERS: gql,
      REST_HEADERS: rest
    }
  })
  return { output: result.stdout.toString() + result.stderr.toString(), code: result.exitCode }
}

const CASES = [
  {
    name: 'both reads succeed',
    fake: 'ok',
    gql: HEADERS('1000', '12', '988'),
    rest: HEADERS('1000', '13', '987').replace('graphql', 'core'),
    line:
      'vinaya-limits: graphql exit=0 status=200 limit=1000 used=12 remaining=988 reset=1790000000 resource=graphql errors=- refused=no' +
      ' | rest exit=0 status=200 limit=1000 used=13 remaining=987 reset=1790000000 resource=core refused=no'
  },
  {
    name: 'a graphql read refused with status 200',
    fake: 'graphql-refused',
    gql: HEADERS('1000', '1000', '0'),
    rest: HEADERS('1000', '1000', '0').replace('graphql', 'core'),
    line:
      'vinaya-limits: graphql exit=1 status=200 limit=1000 used=1000 remaining=0 reset=1790000000 resource=graphql errors=RATE_LIMITED refused=yes' +
      ' | rest exit=0 status=200 limit=1000 used=1000 remaining=0 reset=1790000000 resource=core refused=no'
  },
  {
    name: 'a rest read refused with status 403',
    fake: 'rest-refused',
    gql: HEADERS('5000', '10', '4990'),
    rest: HEADERS('5000', '5000', '0').replace('graphql', 'core'),
    line:
      'vinaya-limits: graphql exit=0 status=200 limit=5000 used=10 remaining=4990 reset=1790000000 resource=graphql errors=- refused=no' +
      ' | rest exit=1 status=403 limit=5000 used=5000 remaining=0 reset=1790000000 resource=core refused=yes'
  },
  {
    name: 'refusals carrying retry-after',
    fake: 'retry',
    gql: HEADERS('5000', '10', '4990', 'Retry-After: 60\n'),
    rest: HEADERS('5000', '11', '4989', 'Retry-After: 60\n').replace('graphql', 'core'),
    line:
      'vinaya-limits: graphql exit=1 status=403 limit=5000 used=10 remaining=4990 reset=1790000000 resource=graphql retry_after=60 errors=OTHER_KIND refused=yes' +
      ' | rest exit=1 status=403 limit=5000 used=11 remaining=4989 reset=1790000000 resource=core retry_after=60 refused=yes'
  }
]

describe('the limits step script against a fake gh', () => {
  for (const c of CASES) {
    it(`prints the exact line when ${c.name}`, () => {
      const { output, code } = runStep(c.fake, c.gql, c.rest)
      expect(code).toBe(0)
      expect(output).toBe(`${c.line}\n`)
      expect(output).not.toContain('WORDING')
      expect(LOOP_WORDING.test(output)).toBe(false)
    })

    it(`is not read as rate-limited by the loop when ${c.name}`, () => {
      const { output } = runStep(c.fake, c.gql, c.rest)
      expect(isRateLimitedJobLog(`${script}\n${output}`)).toBe(false)
    })
  }
})

/**
 * `dispatchRole`'s spawn/timeout/attribution behavior (task 3,
 * `vinaya-log-v1`, Issue #406) — exercised through the real `vinaya dispatch`
 * CLI entry point (`execFileSync('bun', [INDEX, ...])`, same discipline as
 * `apps/cli/tests/commands/issue.test.ts`'s fake `gh`), never by importing
 * `dispatchRole` in-process: `apps/cli/src/lib/config.ts`'s
 * `GLOBAL_VINAYA_HOME` is a module-level constant frozen at first import from
 * whatever `HOME` happens to be, and `@attalabs/aeg-forge-state`'s
 * `resolveRepo()` caches its result for the process lifetime — an in-process
 * `bun:test` run sharing either with another test file in the same run could
 * silently pollute the real developer machine's own `~/.vinaya/outbox/` or
 * read a stale cached repo. A fresh subprocess per test sidesteps both: a
 * scratch `HOME`, and a scratch, non-git `cwd` so `resolveRepo()` resolves
 * `null` (the `unresolved/` outbox bucket) every time.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_VENDOR_NAMES,
  bridgeSocketDir,
  claudeUnconfinedVerdict,
  readClaudeTranscriptUsage,
  resolveClaudeUsageUnits,
  recoverUsageFromDispatchTee,
  sawVendorConnectionRetry,
  detectUsageLimit,
  parseCodexUsageLimitReset,
  unreadDocumentationSources,
  exitFailureReason,
  missingSubscriptionLoginReason,
  logIdentityEnv,
  codexBoundaryFailureReason,
  developerWrittenTextFromVendorOutput,
  type DispatchTeeRecoveryDeps
} from '../../../loops/dev-review/dispatch/dispatch.js'
import { addedDiffLines, findCredentialPatterns } from '../../../../../../apps/cli/src/lib/worker-boundary.js'
import { devToolsSocketRoot } from '../../../../../../apps/cli/src/lib/task-tools/dev-tools-registration.js'
import {
  CLI_ROOT,
  collectLaunchedChildren,
  killLaunchedChild,
  SESSION_ID,
  transcriptLine,
  plantTranscript
} from './dispatch-fixtures.js'

const tempDirs: string[] = []
afterEach(() => {
  // O1: unconditional — runs whether the test above passed, failed, or hit
  // its own subprocess budget, since `afterEach` fires regardless of how the
  // test body exited.
  for (const dir of tempDirs.splice(0)) {
    for (const child of collectLaunchedChildren(dir)) killLaunchedChild(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  // The real path: macOS reaches its temporary directory through a symlink, and
  // tests that compare paths must see the same spelling the product resolves to.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

describe('logIdentityEnv — the run identity a dispatched role carries', () => {
  it("forwards the run's set runner, process and runtime variables and nothing else", () => {
    expect(
      logIdentityEnv({
        VINAYA_PROCESS_ID: 'vinaya',
        VINAYA_PROCESS_VERSION: '0.1.0',
        VINAYA_PROCESS_DIGEST: 'd'.repeat(64),
        VINAYA_RUNNER_ID: 'standalone',
        VINAYA_RUNNER_VERSION: '1.2.3',
        VINAYA_RUNTIME: 'claude',
        VINAYA_ROLE: 'developer',
        SECRET: 'x'
      })
    ).toEqual({
      VINAYA_PROCESS_ID: 'vinaya',
      VINAYA_PROCESS_VERSION: '0.1.0',
      VINAYA_PROCESS_DIGEST: 'd'.repeat(64),
      VINAYA_RUNNER_ID: 'standalone',
      VINAYA_RUNNER_VERSION: '1.2.3',
      VINAYA_RUNTIME: 'claude'
    })
  })

  it('forwards nothing for a process no run launched, and drops empty values', () => {
    expect(logIdentityEnv({ PATH: '/bin' })).toEqual({})
    expect(logIdentityEnv({ VINAYA_RUNNER_ID: '' })).toEqual({})
  })
})

describe('readClaudeTranscriptUsage', () => {
  it('sums input, output and cache once per unique message', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    plantTranscript(configDir, SESSION_ID, [
      transcriptLine('m1', 10, 5, 100, 200),
      transcriptLine('m1', 10, 5, 100, 200),
      transcriptLine('m2', 1, 2, 3, 4)
    ])
    expect(readClaudeTranscriptUsage(SESSION_ID, configDir)).toEqual({
      units: { input: 11, output: 7, cache: 307 },
      unknownReason: null
    })
  })

  it('is unknown with a reason, never zero, when there is no session id, no file, or no message', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    const noId = readClaudeTranscriptUsage(null, configDir)
    expect(noId.units).toEqual({ input: null, output: null, cache: null })
    expect(noId.unknownReason).toContain('session identifier')
    const missing = readClaudeTranscriptUsage(SESSION_ID, configDir)
    expect(missing.units).toEqual({ input: null, output: null, cache: null })
    expect(missing.unknownReason).toContain('session transcript')
    plantTranscript(configDir, SESSION_ID, ['not json', JSON.stringify({ type: 'user' })])
    const empty = readClaudeTranscriptUsage(SESSION_ID, configDir)
    expect(empty.units).toEqual({ input: null, output: null, cache: null })
    expect(empty.unknownReason).toContain('no assistant message')
  })

  it('refuses an identifier that would escape the transcript directory', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    const outside = join(configDir, 'secret')
    writeFileSync(`${outside}.jsonl`, `${transcriptLine('m1', 9, 9, 9, 9)}\n`)
    mkdirSync(join(configDir, 'projects', 'p'), { recursive: true })
    const r = readClaudeTranscriptUsage('../../secret', configDir)
    expect(r.units).toEqual({ input: null, output: null, cache: null })
    expect(r.unknownReason).not.toBeNull()
  })

  it('refuses a transcript symlinked to a file outside the projects directory', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    const outsideDir = tempDir('vinaya-transcript-outside-')
    const outside = join(outsideDir, 'real.jsonl')
    writeFileSync(outside, `${transcriptLine('m1', 9, 9, 9, 9)}\n`)
    const dir = join(configDir, 'projects', 'p')
    mkdirSync(dir, { recursive: true })
    symlinkSync(outside, join(dir, `${SESSION_ID}.jsonl`))
    const r = readClaudeTranscriptUsage(SESSION_ID, configDir)
    expect(r.units).toEqual({ input: null, output: null, cache: null })
    expect(r.unknownReason).toContain('no transcript for session')
  })
})

describe('resolveClaudeUsageUnits', () => {
  const streamKnown = { units: { input: 1, output: 2, cache: 3 }, unknownReason: null }
  const streamUnknown = {
    units: { input: null, output: null, cache: null },
    unknownReason: 'claude emitted no stream-json line'
  }

  it('keeps the stream figures and never reads the transcript when the stream carried usage', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    plantTranscript(configDir, SESSION_ID, [transcriptLine('m1', 999, 999, 999, 999)])
    expect(resolveClaudeUsageUnits(streamKnown, SESSION_ID, configDir)).toEqual({
      observation: streamKnown,
      source: 'stream'
    })
  })

  it('uses the transcript alone, labelled as its source, when the stream had none', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    plantTranscript(configDir, SESSION_ID, [transcriptLine('m1', 10, 5, 1, 2)])
    expect(resolveClaudeUsageUnits(streamUnknown, SESSION_ID, configDir)).toEqual({
      observation: { units: { input: 10, output: 5, cache: 3 }, unknownReason: null },
      source: 'claude-transcript'
    })
  })

  it('names both sources in the reason when neither yields usage', () => {
    const configDir = tempDir('vinaya-transcript-cfg-')
    const r = resolveClaudeUsageUnits(streamUnknown, SESSION_ID, configDir)
    expect(r.source).toBe('stream')
    expect(r.observation.units).toEqual({ input: null, output: null, cache: null })
    expect(r.observation.unknownReason).toContain('claude emitted no stream-json line')
    expect(r.observation.unknownReason).toContain('session transcript')
  })
})

describe('developerWrittenTextFromVendorOutput + the after-turn credential scan — O4 (#1046): only what the turn wrote', () => {
  const REPO_ROOT = join(CLI_ROOT, '..', '..')
  // The two credential-shaped test FIXTURES the brief names, read VERBATIM — so
  // this test proves the scan tolerates the actual bytes this repo ships, not a
  // stand-in. Both carry real credential shapes (an AWS key, a Slack token, an
  // Anthropic key, a PEM block) as fixture values that are not secrets at all.
  const workerBoundaryFixture = readFileSync(
    join(CLI_ROOT, 'tests', 'lib', 'dispatch', 'worker-boundary.test.ts'),
    'utf8'
  )
  const redactFixture = readFileSync(join(REPO_ROOT, 'packages', 'aeg-core', 'src', 'log', 'redact.test.ts'), 'utf8')

  // A Claude `--output-format stream-json` tee for a turn that READ both
  // fixtures: the agent's own message, a `Read` tool_use naming each file (the
  // PATH only), each file's full content coming back as a tool_result (where the
  // credential shapes live), and a benign closing message.
  function readingTurnTee(): string {
    return [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the fixtures.' }] } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: 'apps/cli/tests/lib/dispatch/worker-boundary.test.ts' }
            }
          ]
        }
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: workerBoundaryFixture }] } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'packages/aeg-core/src/log/redact.test.ts' } }
          ]
        }
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: redactFixture }] } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Done reading; nothing to change.' }] }
      })
    ].join('\n')
  }

  it('a turn that READS the two credential-shaped fixtures is not refused — their contents arrive as tool results the extractor drops', () => {
    const written = developerWrittenTextFromVendorOutput(readingTurnTee(), 'claude')
    // It kept the agent's own messages and the Read tool-use PATHS...
    expect(written).toContain('Reading the fixtures.')
    expect(written).toContain('⚙ Read: apps/cli/tests/lib/dispatch/worker-boundary.test.ts')
    // ...and dropped both tool RESULTS, so neither fixture's credential shape is
    // in the scanned text, and the credential scan finds nothing.
    expect(findCredentialPatterns(written, "the Developer's own turn output")).toEqual([])
  })

  it('a turn whose diff ADDS a credential-shaped line is still refused; the same shape only in unchanged context is not', () => {
    const secret = `ghp_${'A'.repeat(40)}`
    const addsIt = ['--- a/src/x.ts', '+++ b/src/x.ts', '@@ -1 +1,2 @@', ' const a = 1', `+const t = '${secret}'`].join(
      '\n'
    )
    const added = addedDiffLines(addsIt)
    expect(added).toContain(secret)
    expect(findCredentialPatterns(added, 'the diff lines this turn added').length).toBeGreaterThan(0)

    // The same secret sitting only in an UNCHANGED context line (a hunk the turn
    // edited nearby but did not write the secret into) is never flagged.
    const contextOnly = [
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,2 +1,2 @@',
      ` const t = '${secret}'`,
      '-const a = 1',
      '+const a = 2'
    ].join('\n')
    const addedCtx = addedDiffLines(contextOnly)
    expect(addedCtx).not.toContain(secret)
    expect(findCredentialPatterns(addedCtx, 'the diff lines this turn added')).toEqual([])
  })

  it('the `+++` file header is never treated as an added line, even though it begins with `+`', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -0,0 +1 @@', '+real content'].join('\n')
    expect(addedDiffLines(diff)).toBe('real content')
  })

  it('retains added content whose first characters are plus signs', () => {
    const secret = `ghp_${'A'.repeat(40)}`
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -0,0 +1 @@', `+++ ${secret}`].join('\n')
    expect(findCredentialPatterns(addedDiffLines(diff), 'added diff')).toHaveLength(1)
  })
})

describe('sawVendorConnectionRetry (pure) — [task-operator-v1]/Issue #662, O2', () => {
  it('true for a real api_retry line, confirmed-live shape (claude CLI 2.1.197)', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 504.3,
        error_status: null,
        error: 'unknown',
        session_id: 's1'
      })
    ].join('\n')
    expect(sawVendorConnectionRetry(stream)).toBe(true)
  })

  it('false for an ordinary stream with no retry marker', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({ stop_reason: 'end_turn', session_id: 's1' })
    ].join('\n')
    expect(sawVendorConnectionRetry(stream)).toBe(false)
  })

  it('false for empty output, and never throws on non-JSON lines', () => {
    expect(sawVendorConnectionRetry('')).toBe(false)
    expect(sawVendorConnectionRetry('not json\nalso not json')).toBe(false)
  })

  it('false for a subtype: api_retry on a DIFFERENT type — the exact shape, not a loose substring match', () => {
    const stream = JSON.stringify({ type: 'assistant', subtype: 'api_retry' })
    expect(sawVendorConnectionRetry(stream)).toBe(false)
  })
})

describe('exitFailureReason — how a failed child exit is classified', () => {
  const base = { usageLimit: false, devToolsStartFailed: false, neverBoundSession: false, connectionRetry: false }
  it('a dev-tools start failure is startup-failed, even when the ended session never bound', () => {
    expect(exitFailureReason({ ...base, devToolsStartFailed: true, neverBoundSession: true })).toBe('startup-failed')
    expect(exitFailureReason({ ...base, devToolsStartFailed: true, connectionRetry: true })).toBe('startup-failed')
  })
  it('a usage limit still outranks a dev-tools start failure', () => {
    expect(exitFailureReason({ ...base, usageLimit: true, devToolsStartFailed: true })).toBe('usage-limit')
  })
  it('keeps the other classifications in their order', () => {
    expect(exitFailureReason({ ...base, neverBoundSession: true, connectionRetry: true })).toBe('unbound')
    expect(exitFailureReason({ ...base, connectionRetry: true })).toBe('connection-failed')
    expect(exitFailureReason(base)).toBe('crash')
  })
})

describe('unreadDocumentationSources', () => {
  it('reports a URL-shaped source never fetched', () => {
    const sources = [{ source: 'https://example.com/docs/a', mechanism: 'the mechanism it governs', objectiveIds: [1] }]
    expect(unreadDocumentationSources(sources, [])).toEqual(sources)
  })

  it('clears a source once its exact URL was fetched', () => {
    const sources = [{ source: 'https://example.com/docs/a', mechanism: 'x', objectiveIds: [1] }]
    expect(unreadDocumentationSources(sources, ['https://example.com/docs/a'])).toEqual([])
  })

  it('tolerates a trailing slash or fragment difference on either side', () => {
    const sources = [{ source: 'https://example.com/docs/a/', mechanism: 'x', objectiveIds: [1] }]
    expect(unreadDocumentationSources(sources, ['https://example.com/docs/a#section'])).toEqual([])
  })

  it('never reports a non-URL (in-repo path) source — WebFetch cannot answer for it', () => {
    const sources = [{ source: 'apps/cli/specs/loop.md', mechanism: 'x', objectiveIds: [1] }]
    expect(unreadDocumentationSources(sources, [])).toEqual([])
  })
})

describe('missingSubscriptionLoginReason — O3 (names where Vinaya looked and how to sign in, never an API key)', () => {
  it('claude: names the credential file in the Claude config directory and the sign-in command', () => {
    const reason = missingSubscriptionLoginReason('claude', { CLAUDE_CONFIG_DIR: '/custom/claude' })
    expect(reason).toContain(join('/custom/claude', '.credentials.json'))
    expect(reason).toContain('/login')
  })

  it('claude: falls back to the documented default config directory when the operator overrides nothing', () => {
    expect(missingSubscriptionLoginReason('claude', {})).toContain(join(homedir(), '.claude', '.credentials.json'))
  })

  it('codex: names the login this host holds and the sign-in command', () => {
    const reason = missingSubscriptionLoginReason('codex', { CODEX_HOME: '/custom/codex' })
    expect(reason).toContain(join('/custom/codex', 'auth.json'))
    expect(reason).toContain('credential store')
    expect(reason).toContain('codex login')
  })

  it('O1: no refusal ever asks the operator for an API key, or names one by variable', () => {
    for (const agent of AGENT_VENDOR_NAMES) {
      const reason = missingSubscriptionLoginReason(agent, {})
      expect(reason, `${agent} names a credential variable`).not.toMatch(/[A-Z]+_API_KEY/)
      expect(reason.toLowerCase(), `${agent} asks for a key`).not.toMatch(
        /set .{0,20}api key|api key .{0,20}(required|missing)/
      )
    }
  })
})

describe('codexBoundaryFailureReason — round 6 review, MAJOR (Issue #676)', () => {
  it('classifies a preflight refusal as authentication-failed', () => {
    expect(codexBoundaryFailureReason('codex', 'Codex subscription authentication preflight failed: exit 1')).toBe(
      'authentication-failed'
    )
  })

  it('classifies a login-step refusal as authentication-failed too — the same class of "no usable session" failure', () => {
    expect(codexBoundaryFailureReason('codex', 'Codex subscription login failed: exit 1')).toBe('authentication-failed')
  })

  it('classifies a failed plugin install (the Documentation-gate hooks) as hook-setup-failed, never startup-failed or authentication-failed', () => {
    expect(
      codexBoundaryFailureReason(
        'codex',
        'Codex documentation-gate hook install failed: codex plugin install failed (exit 1)'
      )
    ).toBe('hook-setup-failed')
  })

  it('classifies any other boundary refusal reason as startup-failed', () => {
    expect(codexBoundaryFailureReason('codex', 'worker boundary unavailable on this host')).toBe('startup-failed')
  })

  it('never classifies a non-codex vendor as authentication-failed even with a matching-shaped reason string', () => {
    expect(codexBoundaryFailureReason('claude', 'Codex subscription authentication preflight failed: exit 1')).toBe(
      'startup-failed'
    )
  })
})

/**
 * `recoverUsageFromDispatchTee` (O1, #608) — entirely deps-injected, so
 * every case here is a fixture: a fake env, a fake set of launch-record
 * files, and fake tee bytes, never this machine's real `~/.vinaya/`.
 */
describe('recoverUsageFromDispatchTee (O1, #608)', () => {
  const LAUNCH_RECORD_PATH = '/fake/tasks-execution/608/sessions/developer-claude.json'

  function launchRecordJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      runId: 'run-1',
      role: 'developer',
      agent: 'claude',
      repo: { owner: 'owner', repo: 'repo' },
      task: 608,
      pr: null,
      round: null,
      attempt: 1,
      effectId: 'effect-abc',
      dispatcherPid: 1,
      childPid: 2,
      host: 'test-host',
      startedAt: '2026-09-14T00:00:00.000Z',
      status: 'completed',
      resumeId: 'resume-1',
      boundAt: '2026-09-14T00:00:00.000Z',
      finishedAt: '2026-09-14T00:01:00.000Z',
      failureReason: null,
      ...overrides
    })
  }

  function assistantLine(id: string, inputTokens: number, outputTokens: number): string {
    return JSON.stringify({
      type: 'assistant',
      message: {
        id,
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      }
    })
  }

  function fakeDeps(opts: {
    env?: Record<string, string | undefined>
    launchRecord?: string | null
    teeLog?: string | null
  }): DispatchTeeRecoveryDeps {
    const env = opts.env ?? { VINAYA_RUN_ID: 'run-1', VINAYA_ROLE: 'developer', VINAYA_TASK: '608' }
    return {
      env,
      listLaunchRecordPaths: () => [LAUNCH_RECORD_PATH],
      readFile: (path: string) => {
        if (path === LAUNCH_RECORD_PATH) {
          if (opts.launchRecord === null) throw new Error('ENOENT')
          return opts.launchRecord ?? launchRecordJson()
        }
        if (path.endsWith('effect-abc.log')) {
          if (opts.teeLog === null) throw new Error('ENOENT')
          return opts.teeLog ?? `${assistantLine('msg_1', 100, 10)}\n${assistantLine('msg_2', 50, 5)}`
        }
        throw new Error(`unexpected read: ${path}`)
      }
    }
  }

  it('sums per-message usage from the matching effect id, deduping by message id', () => {
    const teeLog = [
      assistantLine('msg_1', 100, 10),
      assistantLine('msg_1', 100, 10), // duplicate id — same turn re-emitted mid-stream, must not double-count
      assistantLine('msg_2', 50, 5)
    ].join('\n')
    const result = recoverUsageFromDispatchTee(fakeDeps({ teeLog }))
    expect(result).not.toBeNull()
    expect(result?.summary.components.inputTokens).toBe(150)
    expect(result?.summary.components.outputTokens).toBe(15)
    expect(result?.summary.messageCount).toBe(2)
    expect(result?.teePath.endsWith('effect-abc.log')).toBe(true)
  })

  it('no VINAYA_RUN_ID in env: null, never guesses', () => {
    expect(recoverUsageFromDispatchTee(fakeDeps({ env: { VINAYA_ROLE: 'developer', VINAYA_TASK: '608' } }))).toBeNull()
  })

  it('no VINAYA_TASK in env: null', () => {
    expect(
      recoverUsageFromDispatchTee(fakeDeps({ env: { VINAYA_RUN_ID: 'run-1', VINAYA_ROLE: 'developer' } }))
    ).toBeNull()
  })

  it('a launch record exists but for a different runId: null — never another session’s figures', () => {
    const result = recoverUsageFromDispatchTee(fakeDeps({ launchRecord: launchRecordJson({ runId: 'other-run' }) }))
    expect(result).toBeNull()
  })

  it('a launch record exists but for a different task: null', () => {
    const result = recoverUsageFromDispatchTee(fakeDeps({ launchRecord: launchRecordJson({ task: 999 }) }))
    expect(result).toBeNull()
  })

  it('no launch record on disk at all: null, never throws', () => {
    expect(recoverUsageFromDispatchTee(fakeDeps({ launchRecord: null }))).toBeNull()
  })

  it('launch record found but its tee log is unreadable: null, never throws', () => {
    expect(recoverUsageFromDispatchTee(fakeDeps({ teeLog: null }))).toBeNull()
  })

  it('tee log yields zero usable assistant messages: null', () => {
    expect(recoverUsageFromDispatchTee(fakeDeps({ teeLog: 'not json\n\n' }))).toBeNull()
  })

  it('a corrupt (non-JSON) launch record file: null, never throws', () => {
    expect(recoverUsageFromDispatchTee(fakeDeps({ launchRecord: 'not json' }))).toBeNull()
  })
})

describe('detectUsageLimit (pure) — an agent usage limit is read from the vendor output, never an exit code', () => {
  const NOW = new Date(2026, 9, 8, 10, 0).getTime()
  const CODEX_MESSAGE =
    "You've hit your usage limit. Upgrade to Pro (<link>), visit <link> to purchase more credits or try again at 5:55 PM."
  const codexStream = (message: string): string =>
    [
      '{"type":"thread.started","thread_id":"t1"}',
      JSON.stringify({ type: 'error', message }),
      JSON.stringify({ type: 'turn.failed', error: { message } })
    ].join('\n')

  it('Codex: an error and turn.failed carrying "usage limit" classify with the clock-time reset, today', () => {
    const limit = detectUsageLimit('codex', codexStream(CODEX_MESSAGE), 1, NOW)
    expect(limit).toEqual({
      agent: 'codex',
      message: CODEX_MESSAGE,
      resetAtMs: new Date(2026, 9, 8, 17, 55).getTime()
    })
  })

  it('Codex: a clock time already past today is read as the next occurrence, tomorrow', () => {
    const limit = detectUsageLimit('codex', codexStream(CODEX_MESSAGE.replace('5:55 PM', '9:30 AM')), 1, NOW)
    expect(limit?.resetAtMs).toBe(new Date(2026, 9, 9, 9, 30).getTime())
  })

  it('Codex: an explicit date and time is read exactly', () => {
    const message = CODEX_MESSAGE.replace('5:55 PM', 'Oct 20th, 2026 6:25 PM')
    expect(detectUsageLimit('codex', codexStream(message), 1, NOW)?.resetAtMs).toBe(
      new Date(2026, 9, 20, 18, 25).getTime()
    )
    expect(parseCodexUsageLimitReset('try again at 12:05 AM.', NOW)).toBe(new Date(2026, 9, 9, 0, 5).getTime())
  })

  it('Codex: a message with no time gives a null reset, and an unrelated failure is not a limit', () => {
    expect(detectUsageLimit('codex', codexStream("You've hit your usage limit."), 1, NOW)?.resetAtMs).toBeNull()
    expect(detectUsageLimit('codex', codexStream('stream disconnected'), 1, NOW)).toBeNull()
  })

  const rejected =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1789783200,"rateLimitType":"seven_day","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false}}'
  const errorResult =
    '{"type":"result","subtype":"success","is_error":true,"result":"You\'ve hit your weekly limit · resets Sep 19 at 9am (Asia/Bangkok)"}'

  it('Claude Code: a rejected event without overage, then an error result, classifies with resetsAt', () => {
    const stream = [rejected, '{"type":"assistant","message":{}}', errorResult].join('\n')
    expect(detectUsageLimit('claude', stream, 0, NOW)).toEqual({
      agent: 'claude',
      message: "You've hit your weekly limit · resets Sep 19 at 9am (Asia/Bangkok)",
      resetAtMs: 1789783200 * 1000
    })
    expect(detectUsageLimit('claude', rejected, 1, NOW)?.resetAtMs).toBe(1789783200 * 1000)
  })

  it('Claude Code: a rejected event with overage, or an allowed one, while the run goes on never classifies', () => {
    const overage =
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","overageStatus":"allowed","isUsingOverage":true}}'
    const ok = '{"type":"result","subtype":"success","is_error":false,"result":"done"}'
    expect(detectUsageLimit('claude', [overage, ok].join('\n'), 0, NOW)).toBeNull()
    expect(detectUsageLimit('claude', overage, 1, NOW)).toBeNull()
    const allowed = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","isUsingOverage":false}}'
    expect(detectUsageLimit('claude', [allowed, errorResult].join('\n'), 1, NOW)).toBeNull()
    expect(detectUsageLimit('claude', [rejected, ok].join('\n'), 0, NOW)).toBeNull()
  })
})

describe('claudeUnconfinedVerdict — container mode, with fake probes', () => {
  const probe = (over: Partial<{ platform: NodeJS.Platform; dockerEnv: boolean; dirs: string[] }> = {}) => ({
    platform: () => over.platform ?? ('linux' as NodeJS.Platform),
    dockerEnvPresent: () => over.dockerEnv ?? true,
    socketDirectories: () => over.dirs ?? []
  })
  const unconfined = { confined: false }
  const own = join(devToolsSocketRoot(), 'own')

  it('lets an unconfined Claude dispatch run, with no sandbox probe, only when every condition holds', () => {
    expect(
      claudeUnconfinedVerdict(
        { agent: 'claude', confinement: unconfined, containerMode: true, ownSocketDir: own },
        probe({ dirs: [own] })
      )
    ).toEqual({ refused: false, containerIsBoundary: true, runsSandboxProbe: false, reason: null })
  })

  it('refuses as today when any one condition fails, naming it only when container mode was asked for', () => {
    const verdict = (containerMode: boolean, p: ReturnType<typeof probe>) =>
      claudeUnconfinedVerdict({ agent: 'claude', confinement: unconfined, containerMode, ownSocketDir: own }, p)
    expect(verdict(false, probe())).toEqual({
      refused: true,
      containerIsBoundary: false,
      runsSandboxProbe: false,
      reason: null
    })
    for (const [failing, reason] of [
      [probe({ platform: 'darwin' }), 'needs Linux'],
      [probe({ dockerEnv: false }), '/.dockerenv'],
      [probe({ dirs: [own, join(devToolsSocketRoot(), 'other')] }), 'not the only task in the container']
    ] as const) {
      const refused = verdict(true, failing)
      expect(refused).toMatchObject({ refused: true, containerIsBoundary: false, runsSandboxProbe: false })
      expect(refused.reason).toContain(reason)
    }
  })

  it('leaves a confined Claude dispatch and every Codex dispatch exactly as today', () => {
    expect(
      claudeUnconfinedVerdict(
        { agent: 'claude', confinement: { confined: true }, containerMode: true, ownSocketDir: null },
        probe()
      )
    ).toEqual({ refused: false, containerIsBoundary: false, runsSandboxProbe: true, reason: null })
    expect(
      claudeUnconfinedVerdict({ agent: 'codex', confinement: null, containerMode: true, ownSocketDir: null }, probe())
    ).toEqual({ refused: false, containerIsBoundary: false, runsSandboxProbe: false, reason: null })
  })

  it("reads a dispatch's own socket directory from its bridge", () => {
    expect(bridgeSocketDir({ args: ['entry', 'task-tools', 'dev-bridge', '--socket', join(own, 's.sock')] })).toBe(own)
    expect(bridgeSocketDir(null)).toBeNull()
  })
})

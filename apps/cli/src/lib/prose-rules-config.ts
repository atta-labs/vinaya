import {
  allowedScopesFor,
  CONFIGURABLE_DEFAULT_RULES,
  CONFIGURABLE_PROSE_SCOPES,
  CONFIGURED_PATTERN_MAX_LENGTH,
  CONFIGURED_PROSE_FLAGS,
  DEFAULT_PROSE_RULES,
  groupOfScope,
  type ProseRulesConfig
} from '@attalabs/aeg-core'
import safeRegex from 'safe-regex2'
import { z } from 'zod'

/**
 * `proseGates.rules`, `proseGates.productPaths` and `proseGates.published` —
 * the schema a repository's own writing rules are read through.
 *
 * Every refusal is decided here, when the configuration loads, and names the
 * key it refuses: a malformed rule never falls back to no rule, and a rule a
 * check cannot run is never accepted only to be skipped later. The checks
 * themselves (`check-reader-resolvable-prose.ts`, `check-retired-vocabulary.ts`)
 * trust what this schema let through.
 *
 * The pattern-safety limits — at most `CONFIGURED_PATTERN_MAX_LENGTH`
 * characters, star height at most one as `safe-regex2` decides it — apply to
 * patterns a repository writes, never to the shipped defaults: two of those
 * (the source-comment tranche-slug pattern and the published batch-name
 * pattern) fail the star-height test and keep running as shipped. A
 * repository that copies one of them into a custom rule is refused, and the
 * refusal says why.
 */

type Issue = { path: (string | number)[]; message: string }

const SEVERITIES = ['error', 'warning']

const OVERRIDE_KEYS = ['scopes', 'severity', 'exempt']
const FIXED_DEFAULT_KEYS = ['pattern', 'patterns', 'flags', 'means', 'message', 'id']
const CUSTOM_KEYS = ['id', 'pattern', 'patterns', 'flags', 'means', 'scopes', 'severity', 'exempt']

const DEFAULT_IDS = new Set(DEFAULT_PROSE_RULES.map((rule) => rule.id))

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Why `entry` is not a path inside this repository, or `null` when it is. */
export function outsideRepositoryReason(entry: string): string | null {
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry))
    return 'must be a repository-relative path, not an absolute one'
  if (entry.split(/[\\/]/).includes('..')) return 'must stay inside the repository — no `..` segment'
  return null
}

/** One repository-relative path — the shape `exempt`, `productPaths` and `specPaths` share. */
export const RepoRelativePathSchema = z
  .string()
  .min(1)
  .superRefine((entry, ctx) => {
    const reason = outsideRepositoryReason(entry)
    if (reason) ctx.addIssue({ code: z.ZodIssueCode.custom, message: reason })
  })

function pathListIssues(value: unknown, path: (string | number)[], issues: Issue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be a list of repository-relative paths' })
    return
  }
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      issues.push({ path: [...path, index], message: 'must be a non-empty repository-relative path' })
      return
    }
    const reason = outsideRepositoryReason(entry)
    if (reason) issues.push({ path: [...path, index], message: reason })
  })
}

function scopeListIssues(
  value: unknown,
  path: (string | number)[],
  allowed: readonly string[],
  issues: Issue[]
): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: 'must name at least one scope' })
    return null
  }
  const scopes: string[] = []
  value.forEach((scope, index) => {
    if (typeof scope !== 'string' || !CONFIGURABLE_PROSE_SCOPES.includes(scope)) {
      issues.push({
        path: [...path, index],
        message:
          scope === 'published'
            ? 'scope "published" is not configurable here — the published pass is configured by proseGates.published.allow'
            : `unknown scope ${JSON.stringify(scope)} — the scopes are: ${CONFIGURABLE_PROSE_SCOPES.join(', ')}`
      })
      return
    }
    if (!allowed.includes(scope)) {
      issues.push({
        path: [...path, index],
        message: `scope "${scope}" is not one this rule can run in — it can run in: ${allowed.join(', ')}`
      })
      return
    }
    scopes.push(scope)
  })
  return scopes
}

function severityIssues(value: unknown, path: (string | number)[], scopes: readonly string[], issues: Issue[]): void {
  if (typeof value === 'string') {
    if (!SEVERITIES.includes(value)) {
      issues.push({ path, message: `unknown severity ${JSON.stringify(value)} — use "error" or "warning"` })
    }
    return
  }
  if (!isPlainObject(value)) {
    issues.push({ path, message: 'must be "error", "warning", or a map from scope to one of them' })
    return
  }
  for (const [scope, severity] of Object.entries(value)) {
    if (!scopes.includes(scope)) {
      issues.push({ path: [...path, scope], message: `names scope "${scope}", which this rule's scopes do not cover` })
    }
    if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) {
      issues.push({
        path: [...path, scope],
        message: `unknown severity ${JSON.stringify(severity)} — use "error" or "warning"`
      })
    }
  }
}

function patternIssues(source: unknown, flags: string, path: (string | number)[], issues: Issue[]): void {
  if (typeof source !== 'string' || source.length === 0) {
    issues.push({ path, message: 'must be a non-empty regular expression' })
    return
  }
  if (source.length > CONFIGURED_PATTERN_MAX_LENGTH) {
    issues.push({
      path,
      message: `is ${source.length} characters, over the ${CONFIGURED_PATTERN_MAX_LENGTH}-character limit for a configured pattern`
    })
    return
  }
  try {
    new RegExp(source, flags)
  } catch (err) {
    issues.push({ path, message: `does not compile: ${(err as Error).message}` })
    return
  }
  // Star height alone decides: the repetition count `safe-regex2` also caps
  // by default is lifted, so a long but linear pattern is never refused.
  if (!safeRegex(source, { limit: Number.MAX_SAFE_INTEGER })) {
    issues.push({
      path,
      message:
        'has star height above one (a repeated group that itself repeats), which can take exponential time — ' +
        'safe-regex2 refuses it. The shipped defaults are not held to this limit, so a pattern copied from one of ' +
        'them can still be refused here; rewrite it without the nested repetition.'
    })
  }
}

function flagIssues(value: unknown, path: (string | number)[], issues: Issue[]): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') {
    issues.push({ path, message: 'must be a string of flags, e.g. "i"' })
    return ''
  }
  const seen = new Set<string>()
  for (const flag of value) {
    if (!CONFIGURED_PROSE_FLAGS.includes(flag)) {
      issues.push({
        path,
        message: `unknown flag ${JSON.stringify(flag)} — only ${CONFIGURED_PROSE_FLAGS.map((f) => `"${f}"`).join(' and ')} are allowed`
      })
      return ''
    }
    if (seen.has(flag)) {
      issues.push({ path, message: `repeats the flag "${flag}"` })
      return ''
    }
    seen.add(flag)
  }
  return value
}

function defaultsIssues(value: unknown, issues: Issue[]): void {
  const base = ['defaults']
  if (!isPlainObject(value)) {
    issues.push({ path: base, message: 'must map a default rule id to "off" or an override' })
    return
  }
  for (const [id, override] of Object.entries(value)) {
    const path = [...base, id]
    const rule = CONFIGURABLE_DEFAULT_RULES.find((candidate) => candidate.id === id)
    if (!rule) {
      issues.push({
        path,
        message: `unknown default rule id "${id}" — \`vinaya check --plan\` lists the rules each prose check runs`
      })
      continue
    }
    if (override === 'off') continue
    if (!isPlainObject(override)) {
      issues.push({ path, message: 'must be "off" or an object with any of scopes, severity, exempt' })
      continue
    }
    for (const key of Object.keys(override)) {
      if (OVERRIDE_KEYS.includes(key)) continue
      issues.push({
        path: [...path, key],
        message: FIXED_DEFAULT_KEYS.includes(key)
          ? `a default rule's ${key} is fixed — add a custom rule under proseGates.rules.custom instead`
          : `unknown key "${key}" — a default rule takes only scopes, severity and exempt`
      })
    }
    const scopes =
      override.scopes === undefined
        ? [...rule.scopes]
        : scopeListIssues(override.scopes, [...path, 'scopes'], allowedScopesFor(rule), issues)
    if (override.severity !== undefined && scopes)
      severityIssues(override.severity, [...path, 'severity'], scopes, issues)
    if (override.exempt !== undefined) pathListIssues(override.exempt, [...path, 'exempt'], issues)
  }
}

function customIssues(value: unknown, issues: Issue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path: ['custom'], message: 'must be a list of rules' })
    return
  }
  const ids = new Set<string>()
  value.forEach((rule, index) => {
    const path = ['custom', index]
    if (!isPlainObject(rule)) {
      issues.push({ path, message: 'must be a rule object' })
      return
    }
    for (const key of Object.keys(rule)) {
      if (!CUSTOM_KEYS.includes(key)) {
        issues.push({ path: [...path, key], message: `unknown key "${key}" — a rule takes ${CUSTOM_KEYS.join(', ')}` })
      }
    }
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      issues.push({ path: [...path, 'id'], message: 'a custom rule needs an id' })
    } else if (DEFAULT_IDS.has(rule.id)) {
      issues.push({
        path: [...path, 'id'],
        message: `"${rule.id}" is a default rule id — a custom rule needs its own id; retune the default under proseGates.rules.defaults instead`
      })
    } else if (ids.has(rule.id)) {
      issues.push({ path: [...path, 'id'], message: `"${rule.id}" is used by an earlier custom rule` })
    } else {
      ids.add(rule.id)
    }
    if (typeof rule.means !== 'string' || rule.means.trim().length === 0) {
      issues.push({ path: [...path, 'means'], message: 'a custom rule needs a message (`means`)' })
    }
    let scopes: string[] | null = null
    if (rule.scopes === undefined) {
      issues.push({ path: [...path, 'scopes'], message: 'a custom rule needs at least one scope (`scopes`)' })
    } else {
      scopes = scopeListIssues(rule.scopes, [...path, 'scopes'], CONFIGURABLE_PROSE_SCOPES, issues)
    }
    if (scopes && new Set(scopes.map(groupOfScope)).size > 1) {
      issues.push({
        path: [...path, 'scopes'],
        message:
          'mixes scopes of both prose checks — "repository" belongs to retired-vocabulary and every other scope to reader-resolvable-prose; write one rule per check'
      })
    }
    const flags = flagIssues(rule.flags, [...path, 'flags'], issues)
    if (rule.pattern === undefined && rule.patterns === undefined) {
      issues.push({
        path: [...path, 'pattern'],
        message: 'a custom rule needs a `pattern` or a per-scope `patterns` map'
      })
    }
    if (rule.pattern !== undefined) patternIssues(rule.pattern, flags, [...path, 'pattern'], issues)
    if (rule.patterns !== undefined) {
      if (!isPlainObject(rule.patterns)) {
        issues.push({ path: [...path, 'patterns'], message: 'must map a scope to a regular expression' })
      } else {
        for (const [scope, source] of Object.entries(rule.patterns)) {
          if (scopes && !scopes.includes(scope)) {
            issues.push({
              path: [...path, 'patterns', scope],
              message: `names scope "${scope}", which this rule's scopes do not cover`
            })
            continue
          }
          patternIssues(source, flags, [...path, 'patterns', scope], issues)
        }
        if (rule.pattern === undefined && scopes) {
          for (const scope of scopes) {
            if (!(scope in rule.patterns)) {
              issues.push({
                path: [...path, 'patterns'],
                message: `has no pattern for scope "${scope}" — add one, or a \`pattern\` every other scope uses`
              })
            }
          }
        }
      }
    }
    if (rule.severity !== undefined && scopes) severityIssues(rule.severity, [...path, 'severity'], scopes, issues)
    if (rule.exempt !== undefined) pathListIssues(rule.exempt, [...path, 'exempt'], issues)
  })
}

/** Every refusal `proseGates.rules` earns, each with the path of the key it names, relative to `proseGates.rules`. */
export function proseRulesIssues(value: unknown): Issue[] {
  const issues: Issue[] = []
  if (!isPlainObject(value)) return [{ path: [], message: 'must be an object with any of exempt, defaults, custom' }]
  for (const key of Object.keys(value)) {
    if (!['exempt', 'defaults', 'custom'].includes(key)) {
      issues.push({ path: [key], message: `unknown key "${key}" — proseGates.rules takes exempt, defaults and custom` })
    }
  }
  if (value.exempt !== undefined) pathListIssues(value.exempt, ['exempt'], issues)
  if (value.defaults !== undefined) defaultsIssues(value.defaults, issues)
  if (value.custom !== undefined) customIssues(value.custom, issues)
  return issues
}

/** `proseGates.rules`, validated in full at load. */
export const ProseRulesSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    for (const issue of proseRulesIssues(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message })
    }
  })
  .transform((value) => value as ProseRulesConfig)

/** `proseGates.published` — the published pass's one setting. */
export const PublishedProseSchema = z
  .object({
    // Literals masked out of published text before any rule reads it — the
    // protocol mechanics a reader is meant to learn. Replaces the shipped
    // list (`ALLOWED_MECHANICS`) when set.
    allow: z.array(z.string().min(1)).optional()
  })
  .strict()

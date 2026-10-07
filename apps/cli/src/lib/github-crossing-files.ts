import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

/**
 * The files the registry gates' third rule inspects for a GitHub-writing call —
 * the hook directories' scripts — and the call patterns that make one count.
 * The seventh rule reads the same list, so the two cannot drift apart.
 */

function isGithubCrossingLine(line: string): boolean {
  const createMatch = /\bgh\s+(pr|issue)\s+create\b/.test(line)
  const editWithBodyOrTitle =
    /\bgh\s+(pr|issue)\s+edit\b/.test(line) &&
    /--body\b|--body-file\b|--title\b|(?:^|\s)-b(?:\s|$)|(?:^|\s)-F(?:\s|$)|(?:^|\s)-t(?:\s|$)/.test(line)
  const apiPost =
    /\bgh\s+api\b/.test(line) &&
    /-X\s*POST\b|--method\s*POST\b|(?:^|\s)-f(?:\s|$)|(?:^|\s)-F(?:\s|$)/.test(line) &&
    /(\/pulls|\/issues)(["'\s]|$)/.test(line)
  const apiPatch =
    /\bgh\s+api\b/.test(line) &&
    /-X\s*PATCH\b|--method\s*PATCH\b/.test(line) &&
    /(\/pulls|\/issues)\/[0-9]+(["'\s]|$)/.test(line)
  const curlWrite =
    /\b(curl|wget)\b/.test(line) &&
    /api\.github\.com/.test(line) &&
    /(\/pulls|\/issues)/.test(line) &&
    /-X\s*(POST|PATCH|PUT)\b|--method\s*(POST|PATCH|PUT)\b|--data\b|(?:^|\s)-d(?:\s|$)|--json\b|--post-data\b/.test(
      line
    )
  return createMatch || editWithBodyOrTitle || apiPost || apiPatch || curlWrite
}

export function globCandidateFiles(): string[] {
  const out: string[] = []
  if (existsSync('.husky')) {
    for (const name of readdirSync('.husky')) {
      if (name === '_') continue
      const rel = `.husky/${name}`
      if (statSync(rel).isFile()) out.push(rel)
    }
  }
  if (existsSync('.claude/hooks')) {
    for (const name of readdirSync('.claude/hooks')) {
      if (name.endsWith('.sh')) out.push(`.claude/hooks/${name}`)
    }
  }
  return out
}

export function findCrossingFiles(candidateFiles: string[]): string[] {
  return candidateFiles.filter((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .some((line) => isGithubCrossingLine(line))
  )
}

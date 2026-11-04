/**
 * `git diff <judgedHead>...HEAD -U0`'s own hunk headers bound the changed
 * span exactly — `-U0` means zero context lines, so `@@ -a +c,d @@` already
 * IS the delta, with no need to diff-parse context away.
 */
export function parseChangedLineRanges(diffOutput: string): Record<string, Array<[number, number]>> {
  const result: Record<string, Array<[number, number]>> = {}
  let currentFile: string | null = null
  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim()
      currentFile = path === '/dev/null' ? null : path.replace(/^b\//, '')
      continue
    }
    if (line.startsWith('@@') && currentFile) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
      if (m) {
        const start = Number(m[1])
        const count = m[2] !== undefined ? Number(m[2]) : 1
        if (count > 0) {
          if (!result[currentFile]) result[currentFile] = []
          ;(result[currentFile] as Array<[number, number]>).push([start, start + count - 1])
        }
      }
    }
  }
  return result
}

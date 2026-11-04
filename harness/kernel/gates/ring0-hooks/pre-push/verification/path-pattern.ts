/**
 * The two path-pattern grammars the selection library matches with. Both read
 * repository-relative, `/`-separated paths and anchor the whole path.
 *
 * - {@link globToRegex} — the simple grammar: `**` is any run of characters
 *   (separators included), `*` any run within one segment, and every other
 *   character is literal, so a bracketed route segment such as `[slug]`
 *   matches itself without escaping. Selection policy globs (a list of tests
 *   that run whatever changed) use it.
 * - {@link globRegex} — the runner grammar a test runner's own `include` and
 *   `exclude` lists are written in: `**​/` any folders or none, `*` within one
 *   segment, `?` one character, `{a,b}` alternatives. Inventory readers and
 *   collection patterns use it.
 */

/** A simple glob as an anchored regular expression: `**` any characters, `*` any within a segment, everything else literal. */
export function globToRegex(pat: string): RegExp {
  let re = '^'
  let i = 0
  while (i < pat.length) {
    const c = pat[i]
    if (c === '*') {
      if (pat[i + 1] === '*') {
        re += '.*'
        i += 2
      } else {
        re += '[^/]*'
        i += 1
      }
    } else if (/[.+^$|(){}[\]\\?]/.test(c as string)) {
      re += `\\${c}`
      i += 1
    } else {
      re += c
      i += 1
    }
  }
  re += '$'
  return new RegExp(re)
}

/** A runner glob as a regular expression: `**​/` any folders (or none), `*` within one segment, `?`, `{a,b}`. */
export function globRegex(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const close = glob.indexOf('}', i)
      if (close < 0) re += '\\{'
      else {
        re += `(?:${glob
          .slice(i + 1, close)
          .split(',')
          .map((alt) => globRegex(alt).source.slice(1, -1))
          .join('|')})`
        i = close
      }
    } else re += /[.+^$|()[\]\\]/.test(c) ? `\\${c}` : c
  }
  return new RegExp(`${re}$`)
}

/** Whether a declared input covers `path`: a folder (written with a trailing `/`) covers everything below it, a file only itself. */
export function inputCovers(input: string, path: string): boolean {
  return input.endsWith('/') ? path.startsWith(input) : path === input
}

/** Whether a repository-relative path lies under one declared prefix root — a folder, a file, or a file-name prefix; `.` is the whole repository. */
export function underDeclaredRoot(path: string, root: string): boolean {
  return root === '.' || path.startsWith(root)
}

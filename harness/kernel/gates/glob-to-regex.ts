/**
 * Translate a doc-owners glob to a RegExp. Deliberately simple — only `*` and
 * `**` are special; every other character is literal so Next.js dynamic-route
 * segments like `[username]` match without escaping.
 */
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

/** The stable hash used by both a config section and its on-page navigation. */
export function configFieldSlug(key: string): string {
  return `config-${key.replace(/\./g, '-')}`
}

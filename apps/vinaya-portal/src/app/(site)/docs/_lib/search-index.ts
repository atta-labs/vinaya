import { COMMANDS } from '@attalabs/vinaya-sources/commands'
import { CONFIG_REFERENCE } from '@attalabs/vinaya-sources/config-reference'
import { commandSlug } from '../(standalone)/cli/_components/command-slug'
import { configFieldSlug } from '../(standalone)/config/_components/config-navigation'
import { DOCS_PAGES, HARNESS_COMMANDS, HARNESS_KEYS, PROCESS_KEYS, topKey } from './portal-docs'

type SearchItem = { label: string; hint: string; href: string }
export type SearchGroup = { heading: string; items: SearchItem[] }

/**
 * What the docs search finds: every page, every command a person runs and every
 * config key, each pointing at the page and anchor that documents it. Built on
 * the server, so the command and key data never ship to the browser twice.
 */
export function docsSearchIndex(): SearchGroup[] {
  const command = (name: string, page: string): SearchItem | undefined => {
    const c = COMMANDS.find((x) => x.name === name)
    return c && { label: `vinaya ${c.name}`, hint: c.description, href: `${page}#${commandSlug(c.name)}` }
  }
  const keys = (top: string[], page: string): SearchItem[] =>
    CONFIG_REFERENCE.filter((f) => top.includes(topKey(f.key))).map((f) => ({
      label: f.key,
      hint: page.includes('/process/') ? 'Process setting' : 'Harness setting',
      href: `${page}#${configFieldSlug(f.key)}`
    }))
  return [
    { heading: 'Pages', items: DOCS_PAGES.map((p) => ({ label: p.title, hint: p.group.title, href: p.href })) },
    {
      heading: 'Commands',
      items: HARNESS_COMMANDS.flat()
        .map((n) => command(n, '/docs/start/cli'))
        .filter((i) => i !== undefined)
    },
    {
      heading: 'Configuration',
      items: [...keys(HARNESS_KEYS, '/docs/features/configuration'), ...keys(PROCESS_KEYS, '/docs/process/vinaya-keys')]
    }
  ]
}

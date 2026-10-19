import { getPortalCms } from '@/lib/portal-cms'
import { DocsSearch } from '../../../(site)/docs/_components/DocsSearch'
import { docsSearchIndex } from '../../../(site)/docs/_lib/search-index'

export const demoMetadata = { title: 'Interactive demo · The Vinaya process' }

/** What every demo page passes its client page: the Vinaya mark from the CMS and the docs search. */
export async function demoChrome() {
  const { branding } = await getPortalCms()
  const logoUrl = branding?.logoSolidDark?.url ?? branding?.logoSolidLight?.url ?? null
  return { logoUrl, search: <DocsSearch groups={docsSearchIndex()} /> }
}

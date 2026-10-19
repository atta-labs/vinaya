import { getPortalCms } from '@/lib/portal-cms'
import { DiagramPanel } from '@/process/diagram/DiagramPanel'
import { PortalBar } from '../../(site)/_components/PortalBar'
import { DocsSearch } from '../../(site)/docs/_components/DocsSearch'
import { docsSearchIndex } from '../../(site)/docs/_lib/search-index'

export const metadata = { title: 'Full diagram · The Vinaya process' }

/** The whole Vinaya process on one screen: every flow, every stage, under the site's own bar. */
export default async function DiagramPage() {
  const { branding } = await getPortalCms()
  const logoUrl = branding?.logoSolidDark?.url ?? branding?.logoSolidLight?.url ?? null
  return (
    <div className='flex h-dvh flex-col bg-background'>
      <header className='shrink-0 border-b border-border/40'>
        <PortalBar logoUrl={logoUrl} search={<DocsSearch groups={docsSearchIndex()} />} />
      </header>
      <DiagramPanel className='min-h-0 flex-1' />
    </div>
  )
}

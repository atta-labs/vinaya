import type { ReactNode } from 'react'
import { FooterContentSlot } from '../../_components/FooterGate'
import { DocsPager } from '../_components/DocsPager'
import { DocsShell } from '../_components/DocsShell'
import { DocsToc } from '../_components/DocsToc'
import { PortalDocsSidebar } from '../_components/PortalDocsSidebar'

/**
 * Every docs page: the two halves in the sidebar, then a scrolling pane with the article, centred, and the pager,
 * closed by the footer; from `xl` the page's contents sit in their own column on the right.
 */
export default function GuideLayout({ children }: { children: ReactNode }) {
  return (
    <DocsShell sidebar={<PortalDocsSidebar />} sidebarLabel='Docs'>
      {/* The content pane scrolls on its own; from `xl` the page's contents take their own full-height
          column on the right, outside it, so the reading bar spans only the content. */}
      <div className='flex min-h-0 flex-1'>
        <main className='min-h-0 min-w-0 flex-1 overflow-y-auto bg-background'>
          {/* The reading bar portals in here (`StickyDocHeader`): pinned, and as wide as the content pane. */}
          <div id='doc-sticky-slot' className='sticky top-0 z-20 h-0 overflow-visible' />
          <div className='mx-auto max-w-[54rem] px-6 pt-10 pb-16 lg:px-12'>
            <article data-doc-article>{children}</article>
            <DocsPager />
          </div>
          <FooterContentSlot />
        </main>
        <aside className='hidden w-72 shrink-0 overflow-y-auto px-8 pt-10 xl:block'>
          <DocsToc />
        </aside>
      </div>
    </DocsShell>
  )
}

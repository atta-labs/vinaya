import type { ReactNode } from 'react'
import { FooterContentSlot } from '../../_components/FooterGate'
import { DocsPager } from '../_components/DocsPager'
import { DocsShell } from '../_components/DocsShell'
import { DocsToc } from '../_components/DocsToc'
import { PortalDocsSidebar } from '../_components/PortalDocsSidebar'

/**
 * Every docs page: the two halves in the sidebar, then a scrolling pane with the
 * article and, from `xl`, the page's contents beside it, centred together in the pane, then the pager. The footer
 * closes the pane.
 */
export default function GuideLayout({ children }: { children: ReactNode }) {
  return (
    <DocsShell sidebar={<PortalDocsSidebar />} sidebarLabel='Docs'>
      <main className='min-h-0 flex-1 overflow-y-auto bg-background'>
        {/* The article and its contents are one block, centred in the pane, so spare
            width splits evenly on both sides. The block is 48rem of article, plus a 3rem
            gap and the 14rem contents from `xl`, inside a 3rem gutter each side. The top
            bar's links follow the article's left edge with the same numbers (site layout). */}
        <div className='mx-auto flex max-w-[54rem] gap-12 px-6 pt-10 pb-16 lg:px-12 xl:max-w-[71rem]'>
          <div className='min-w-0 max-w-3xl flex-1'>
            <article data-doc-article>{children}</article>
            <DocsPager />
          </div>
          <aside className='hidden w-56 shrink-0 xl:block'>
            <div className='sticky top-10'>
              <DocsToc />
            </div>
          </aside>
        </div>
        <FooterContentSlot />
      </main>
    </DocsShell>
  )
}

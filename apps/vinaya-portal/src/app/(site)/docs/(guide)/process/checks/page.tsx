import { DocHead, DocLink, DocSection, P } from '../../../_components/PortalDoc'
import { ChecksCatalog } from './ChecksCatalog'

export const metadata = { title: 'Checks catalog · Vinaya Docs' }

export default function ChecksCatalogPage() {
  return (
    <>
      <DocHead
        half='process'
        title='Checks catalog'
        href='/docs/process/checks'
        line='All 37 core checks in one table: what each refuses, where it first runs, and which gate it implements.'
      />
      <DocSection title='All checks'>
        <P>
          Filter by where a check first runs, or by whether it implements a generic gate or exists only because of how
          Vinaya works. Each name links to the check&apos;s full entry. How the rings work is in{' '}
          <DocLink href='/docs/process/gates'>Gates</DocLink>.
        </P>
        <ChecksCatalog />
      </DocSection>
    </>
  )
}

import { ProcessPage } from '@/process/components/ProcessPage'
import { demoChrome, demoMetadata } from './_lib/chrome'

export const metadata = demoMetadata

/** The interactive demo's setup wizard, under the site's own bar. Start opens the chosen flow's subpage. */
export default async function DemoPage() {
  return <ProcessPage {...(await demoChrome())} />
}

import { HotWalk } from '@/process/flows/hot/HotWalk'
import { demoChrome, demoMetadata } from '../_lib/chrome'

export const metadata = demoMetadata

/** Hot issue: one deploy, walked step by step, under the site's own bar. */
export default async function Page() {
  return <HotWalk {...(await demoChrome())} />
}

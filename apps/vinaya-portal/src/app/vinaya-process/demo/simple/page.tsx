import { SimpleWalk } from '@/process/flows/simple/SimpleWalk'
import { demoChrome, demoMetadata } from '../_lib/chrome'

export const metadata = demoMetadata

/** Simple task: one deploy, walked step by step, under the site's own bar. */
export default async function Page() {
  return <SimpleWalk {...(await demoChrome())} />
}

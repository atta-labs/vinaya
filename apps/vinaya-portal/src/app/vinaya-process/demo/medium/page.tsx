import { MediumWalk } from '@/process/flows/medium/MediumWalk'
import { demoChrome, demoMetadata } from '../_lib/chrome'

export const metadata = demoMetadata

/** Medium work: one deploy, walked step by step, under the site's own bar. */
export default async function Page() {
  return <MediumWalk {...(await demoChrome())} />
}

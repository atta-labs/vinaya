import { ComplexWalk } from '@/process/flows/complex/ComplexWalk'
import { demoChrome, demoMetadata } from '../_lib/chrome'

export const metadata = demoMetadata

/** Complex work: one deploy, walked step by step, under the site's own bar. */
export default async function Page() {
  return <ComplexWalk {...(await demoChrome())} />
}

import { getPortalCms } from '@/lib/portal-cms'
import { ProcessLanding } from './_components/ProcessLanding'

export const metadata = { title: 'The Vinaya process · Vinaya' }

export default async function VinayaProcessPage() {
  const { branding } = await getPortalCms()
  return <ProcessLanding logoUrl={branding?.logoSolidDark?.url ?? branding?.logoSolidLight?.url ?? null} />
}

import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import type { ReactNode } from 'react'
import { SystemShell } from '@/process/system/shell'

/** The gallery is hidden on the production deployment only; local development and Vercel previews render it. */
export default async function SystemLayout({ children }: { children: ReactNode }) {
  // Read at request time: a static build would bake in the value it had while building.
  await connection()
  if (process.env.VERCEL_ENV === 'production') notFound()
  return <SystemShell>{children}</SystemShell>
}

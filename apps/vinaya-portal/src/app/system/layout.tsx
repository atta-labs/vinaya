import type { ReactNode } from 'react'
import { SystemShell } from '@/process/system/shell'

export default function SystemLayout({ children }: { children: ReactNode }) {
  return <SystemShell>{children}</SystemShell>
}

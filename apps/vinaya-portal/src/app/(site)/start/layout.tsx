import type { ReactNode } from 'react'

/** The content container for `/start/*` — without it `/start/quick` renders
 * edge-to-edge with no padding. */
export default function StartLayout({ children }: { children: ReactNode }) {
  return (
    <main className='px-6 pb-10 lg:px-12'>
      <div className='mx-auto max-w-4xl pt-10'>{children}</div>
    </main>
  )
}

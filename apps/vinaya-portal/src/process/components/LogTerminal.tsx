'use client'

import { useMemo } from 'react'
import { cn } from '@/ui/lib/utils'
import type { ChatLine, Environment, LogEvent } from '../types'
import { ChatWindow } from './ChatWindow'

/**
 * The Log as the reader would tail it: a shell of their OS running
 * `vinaya log tail --follow`, one line per event. Fixed height; events
 * scroll inside, newest at the bottom.
 */
export function LogTerminal({ events, env, className }: { events: LogEvent[]; env: Environment; className?: string }) {
  const lines = useMemo<ChatLine[]>(
    () => [
      { kind: 'cmd', text: 'vinaya log tail --follow' },
      ...events.map((e): ChatLine => ({ kind: 'ev', text: `${e.name}  ${e.detail}` }))
    ],
    [events]
  )
  return (
    <ChatWindow
      fixed
      surface='terminal'
      lines={lines}
      env={env}
      tone='log'
      className={cn('h-[clamp(200px,32dvh,320px)]', className)}
    />
  )
}

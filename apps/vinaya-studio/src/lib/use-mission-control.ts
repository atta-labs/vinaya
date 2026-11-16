'use client'

import { useEffect, useState } from 'react'
import {
  type ConnectionSocket,
  createMissionControlConnection,
  type MissionControlConnection,
  type MissionControlState
} from './mission-control-connection.ts'

/** The application WebSocket route; the same constant the host serves (`server/live-protocol.ts`). */
const LIVE_PATH = '/api/mission-control/live'

/** How often the page re-reads the local clock so task ages keep advancing between frames. */
export const AGE_TICK_MS = 1_000

const INITIAL: MissionControlState = {
  phase: 'connecting',
  generation: 0,
  repositories: {},
  lastUpdateAt: null,
  attempts: 0
}

export type UseMissionControlOptions = {
  /** Opens one socket to the live route. Defaults to the browser's WebSocket on this page's own origin; the session cookie is the only credential. */
  createSocket?: () => ConnectionSocket
  clock?: () => number
}

export type MissionControlHandle = {
  state: MissionControlState
  /** The local clock, advancing every second, for ages. It never decides a task's state. */
  now: number
  retry: () => void
}

function browserSocket(): ConnectionSocket {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${scheme}//${window.location.host}${LIVE_PATH}`) as unknown as ConnectionSocket
}

/** Connects the page to Mission Control once it is mounted and gives the latest projected picture. Renders nothing itself. */
export function useMissionControl(options: UseMissionControlOptions = {}): MissionControlHandle {
  const clock = options.clock ?? Date.now
  const [connection, setConnection] = useState<MissionControlConnection | null>(null)
  const [state, setState] = useState<MissionControlState>(INITIAL)
  const [now, setNow] = useState<number>(() => clock())

  useEffect(() => {
    const next = createMissionControlConnection({ createSocket: options.createSocket ?? browserSocket, clock })
    const unsubscribe = next.subscribe(() => setState(next.getState()))
    setConnection(next)
    next.connect()
    return () => {
      unsubscribe()
      next.dispose()
    }
    // The socket factory and clock are fixed for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setNow(clock()), AGE_TICK_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { state, now, retry: () => connection?.retry() }
}

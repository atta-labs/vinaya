/**
 * The application WebSocket's route and greeting. Imports nothing, so the host, its tests and the packed-install proof
 * in the CLI read the same two values without the CLI's type check loading Next's types.
 */

/** The one application WebSocket route of Mission Control. */
export const LIVE_ROUTE = '/api/mission-control/live'

/** The greeting the application upgrade smoke handler sends: a fixed frame, no repository data. */
export const LIVE_HELLO = JSON.stringify({ type: 'hello' })

/**
 * Vinaya's seat names — which seats its tool server serves, the MCP server
 * name each is registered under, and the default seat — and nothing else. It
 * imports no tool module, so the generated registrations (`adapters.ts`) read
 * the names from here without loading the tool server (`server.ts`) or any
 * role's tools. The tool server builds its seat table (`vinayaToolSeats`) over
 * these same names, in this order, so the names have one source.
 */

/** The Operator's seat — what `--seat` names, and the seat a launch with no seat argument serves. */
export const OPERATOR_SEAT = 'operator'

/** The Planner's seat — what `--seat planner` names. */
export const PLANNER_SEAT = 'planner'
export const ARCHITECT_SEAT = 'architect'
export const TRANCHE_ARCHIVIST_SEAT = 'tranche-archivist'

/** The one MCP server name both adapters register — the key under `mcpServers`/`[mcp_servers.<name>]`. */
export const TASK_TOOLS_MCP_SERVER_NAME = 'vinaya-task-tools'

/** The MCP server name the generated configurations register the Planner's seat under. */
export const PLANNER_TOOLS_MCP_SERVER_NAME = 'vinaya-planner-tools'
export const ARCHITECT_TOOLS_MCP_SERVER_NAME = 'vinaya-architect-tools'
export const TRANCHE_ARCHIVIST_TOOLS_MCP_SERVER_NAME = 'vinaya-tranche-archivist-tools'

/** One of the seats Vinaya declares. */
export type VinayaSeatName =
  | typeof OPERATOR_SEAT
  | typeof PLANNER_SEAT
  | typeof ARCHITECT_SEAT
  | typeof TRANCHE_ARCHIVIST_SEAT

/** A seat as the names-only table declares it: what `--seat` names, and the MCP server name it is registered under. */
export type VinayaSeatNames = { readonly name: VinayaSeatName; readonly serverName: string }

/**
 * Every seat Vinaya declares, in the order the seat table and the generated
 * registrations list them, and the default seat — the Operator's, which keeps
 * the server name every generated configuration already registers.
 */
export const VINAYA_SEAT_NAMES: { readonly seats: readonly VinayaSeatNames[]; readonly defaultSeat: VinayaSeatName } = {
  defaultSeat: OPERATOR_SEAT,
  seats: [
    { name: OPERATOR_SEAT, serverName: TASK_TOOLS_MCP_SERVER_NAME },
    { name: PLANNER_SEAT, serverName: PLANNER_TOOLS_MCP_SERVER_NAME },
    { name: ARCHITECT_SEAT, serverName: ARCHITECT_TOOLS_MCP_SERVER_NAME },
    { name: TRANCHE_ARCHIVIST_SEAT, serverName: TRANCHE_ARCHIVIST_TOOLS_MCP_SERVER_NAME }
  ]
}

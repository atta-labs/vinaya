/**
 * The driver-run dev-tools MCP server's name — a leaf module (no imports) so
 * the per-dispatch registration (`dev-tools-registration.ts`), which
 * `dispatch.ts` pulls in, never drags the Operator's whole task-tools server
 * (`server.ts`, reached transitively through `dev-tools-server.ts`) into
 * `dispatch.ts`'s own module graph — that edge closed a load-order cycle
 * (`dispatch` → registration → server → … → `dev-review-loop` → `dispatch`,
 * which left `AGENT_VENDOR_NAMES` read before its own initialization).
 */

/** The one MCP server name both per-dispatch registrations use — distinct from the Operator's `vinaya-task-tools`. */
export const DEV_TOOLS_MCP_SERVER_NAME = 'vinaya-dev-tools'

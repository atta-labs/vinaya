# harness/processes/vinaya-strict/thinking/architect

The Architect owns Milestone create, edit, delete, adopt, close and status.
Its four exclusive tools live in `tools/architect-tools.ts`; status and close
are shared with the Tranche Archivist in `../../tools/milestone/milestone-tools.ts`.
The seat table in `../../integration/server.ts` binds the six tools to its grant.

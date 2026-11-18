# @attalabs/vinaya-log-sdk

The Vinaya Log's contract, in one package that imports nothing from the harness: the event schema (`src/contract/schema.ts`), the consumer-declared custom events (`src/contract/custom.ts`), redaction (`src/contract/redact.ts`) and the stored-line classifier with its storage contract (`src/contract/store.ts`).

The harness keeps each of these paths as a one-line re-export of the file here, so its importers, the Log server and Studio read the same contract they always did. Nothing the Log records, stores or rejects changes.

The package is private for now. Decision 0017 (`docs/adr/0017-the-log-is-opentelemetry.md`) records where it goes: the Log is built on OpenTelemetry.

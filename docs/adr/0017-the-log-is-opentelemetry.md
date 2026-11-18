# 0017. The Log is OpenTelemetry

**Status:** Accepted

**Date:** 2026-11-18

## Context

The Log is a stream of Vinaya's own events, each a JSON line with a schema version, in a format only Vinaya reads. Every reader, the Log server and Studio included, has to know that format, and no tool outside this repository can show a run without a converter. Meanwhile OpenTelemetry has become the common shape for the same material: a trace for a unit of work, spans for anything with a start and an end, log records for single moments, and published conventions for agent runs (the GenAI agent span conventions: `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.agent.id`, `gen_ai.tool.name` and related attributes).

Decision 0007 fixed where the Log goes and that it is delivered live. It says nothing about the shape of what is delivered, and this record leaves it standing.

## Decision

We will build the Log on OpenTelemetry.

- One run is one trace.
- Anything with a start and an end, such as a round, a turn or a gate, is a span.
- A single moment, such as a pause or a refusal, is a log-record event on the span that holds it.
- Attributes use OpenTelemetry's GenAI names where one exists, and `vinaya.*` names for everything else.
- The version of the conventions in use is recorded on every run, so a reader knows which names it is reading.
- The local copy of a run is OpenTelemetry's JSON-lines file format (one OTLP JSON object per line, UTF-8, `\n` separated, `.jsonl`), the same one the file exporter specification describes.
- The earlier Vinaya event format stays readable by conversion: a Log written before this decision is converted to the new shape on read and is never rewritten.

The Log's contract (the event schema, custom-event declarations, redaction and the stored-line classifier) moves to its own package, `@attalabs/vinaya-log-sdk`, so the new shape can be built there without the harness. The first step moves the four files and changes nothing the Log records, stores or rejects.

## Considered options

- Keep the Vinaya event format. It costs nothing now, but every reader and tool outside the repository needs a converter, and the agent conventions keep moving without us.
- Send OpenTelemetry alongside the Vinaya format. Two records of one run can disagree, and the second one needs its own redaction and delivery.
- Build the Log on OpenTelemetry and convert the old format on read. This is the chosen option.

## Consequences

Any OpenTelemetry-aware tool can read a run. The names we depend on belong to a convention still being written, so the recorded conventions version is what keeps older runs readable. Readers gain a conversion step for old Logs. Logs stay off the forge, live and in the configured destination, as decision 0007 says.

## Where it is applied

`packages/log-sdk` holds the Log's contract. `harness/kernel/log/log.md` describes the Log as it is recorded today.

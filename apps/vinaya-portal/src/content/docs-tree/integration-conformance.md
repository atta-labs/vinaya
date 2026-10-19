# Conformance — Vinaya

Summary: The conditions under which the Vinaya process conforms to the Dev Process contract, one for each generic condition.
Parent: Integration
Badges: Eight conditions

## About Vinaya's conformance

This page answers the generic [Conformance](/docs/dev-process/conformance) for the Vinaya process.

## Vinaya conforms when

| Generic condition | Vinaya condition |
| --- | --- |
| The declaration activates without hidden defaults | The process installs, pins, upgrades and resumes through the public loader without a privileged default path |
| Every object and authority relationship can be produced and linked | Every generic object, identity and authority relationship maps to Vinaya's declarations. See [Process contract](/docs/process/integration/process-contract). |
| Generic gates cover positive, negative, unavailable and inapplicable cases | Generic and Vinaya-specific gates exercise all four cases |
| Transitive invalidation works | Revision, Intent, policy and applicability changes produce transitive invalidation |
| Events are enough for Mission Control and statistics | The harness can emit complete common events and derive Mission Control and comparable statistics without Vinaya-specific hidden data. See [Logging](/docs/process/integration/logging). |
| Effects and extensions are registered and bounded | External calls route through registered adapters and governed effects |
| Unsupported behaviour is refused precisely | Behaviour Vinaya does not support is refused with a precise reason, never approximated |
| The same semantics hold across supported adapters | The same semantics hold on `claude` and `codex`, and on the GitHub tracker and code host |

The repository's doctrine, schemas, checks and commands implement this and may add operational detail without contradicting it.

## What's next

```cards
- [Logging](/docs/process/integration/logging) What Vinaya records
- [Conformance](/docs/dev-process/conformance) The generic conditions
- [Gates](/docs/process/gates) Vinaya's checks and the generic gates they implement
```

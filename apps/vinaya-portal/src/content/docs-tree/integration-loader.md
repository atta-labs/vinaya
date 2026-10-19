# Loader — Vinaya

Summary: How the Vinaya process is packaged, selected, pinned into each Run and extended through the public loader.
Parent: Integration
Badges: Versioned package · Pinned per Run · No privileged path

## About how Vinaya is loaded

This page answers the generic [Loader](/docs/dev-process/loader) for the Vinaya process.

## How it works

```steps
### Package
Vinaya is a namespaced, versioned process package with a digest and a compatible harness API.

### Selection
The configuration names the process; Vinaya is the default.

### Pinning
The process and policy versions are pinned into each Run. A running Run never changes version.

### Extensions
Its brief parser, Surface parser, required-source provider and 20 Vinaya-specific checks are registered as versioned extensions. The loader refuses what does not fit.
```

Vinaya installs, pins, upgrades and resumes through the public loader, with no privileged default path.

```callout-note
The loader is planned.
```

## Configuration

None. `vinaya init` installs the harness and Vinaya together. See [Setup commands](/docs/features/configuration/setup-commands).

## What's next

```cards
- [Conformance](/docs/process/integration/conformance) When Vinaya conforms
- [Loader](/docs/dev-process/loader) The generic loader
- [Setup commands](/docs/features/configuration/setup-commands) init, doctor, upgrade, eject
```

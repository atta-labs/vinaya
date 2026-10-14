# 0003. Subscription login only

**Status:** Accepted

**Date:** 2026-09-26

## Context

Vinaya starts coding agents unattended, inside a sandbox, on a developer's machine or a server. Each vendor offers two ways to authenticate: a subscription login that the vendor's own command-line tool stores, and an API key that bills each request. An API key is a long-lived secret that has to be placed in the environment of the process that runs the agent, which is the same process the sandbox is meant to confine. A key in that environment can be read by the agent, copied into a log, or left behind on a server.

At the time, more than one route into an agent accepted an API key, and one supported vendor offered no subscription login that Vinaya could stage for a confined run.

## Decision

We will authenticate every agent, for every role, through its vendor's subscription login only. No agent authenticates with an API key, and no API-key fallback exists for any agent.

The trusted controller stages the saved subscription login for a confined run. An agent for which Vinaya has no subscription login route is refused before an unattended dispatch starts, with a reason that names the agents that can be dispatched instead.

## Considered options

- API keys for every agent. Keys are simple to provision and work the same way on every host. They are, however, long-lived secrets that would sit inside the confined process's environment, and they move cost to per-request billing.
- Subscription login where available, API keys as a fallback. This keeps every vendor usable, but it leaves the key route open, and an open route is the one an unattended run falls back to when a login is missing.
- Subscription login only, refusing an agent that has none. This is the chosen option. It removes the secret from the agent's environment entirely, at the price of switching off a vendor until it has a login Vinaya can stage.

## Consequences

No API key is ever read, forwarded or stored on behalf of an agent, so a confined agent has no key to leak. Authentication failures surface as a missing or expired login, with the path where the login was expected.

A vendor without a subscription login route cannot be dispatched unattended; that vendor stays switched off until such a route exists. Every host that runs agents needs an interactive login once per vendor before it can run unattended, and a usage limit on the subscription ends a run rather than spilling into paid requests.

## Where it is applied

`apps/cli/src/lib/dispatch.ts` refuses an unattended dispatch of an agent with no subscription login (`hasSubscriptionLogin`, `NO_SUBSCRIPTION_LOGIN_REASON`) and names a missing login with `missingSubscriptionLoginReason`. `apps/cli/src/lib/worker-boundary.ts` stages and checks the Codex subscription login for a confined run.

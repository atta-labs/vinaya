# processes/vinaya

The Vinaya process: its roles, Flows, gates and evaluations. Belongs to the "Any Process, One Harness" project.

The Engine runner stamps its Log events with the loaded process identity
(id, version and loader digest) and runner `atta-engine`. The runner version
comes from the installed `@atta/engine` package's own `package.json`.
It sets the producer identity environment before creating its Log sink;
the header's runtime retains its existing meaning.

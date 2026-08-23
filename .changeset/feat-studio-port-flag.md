---
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": minor
---

`vinaya studio` accepts `--port <n>`. Without it the existing behaviour is unchanged: bind `3008`, or fall back to `3108` when that is taken. With it, the named port is bound and a taken port is a **refusal** rather than a silent move to the fallback — because a caller who names a port is doing so to know which server answered, and quietly binding a different one destroys exactly the certainty they were buying. Measured while adding this: with two Studio servers running, one on `*:3008` and one on `127.0.0.1:3008`, a `200` from `/studio` proved nothing about which process served it without inspecting the established connection.

The flag applies to a published install, where this CLI launches the bundled standalone server and owns the port. In a workspace checkout it is refused with an explanation: that path execs Studio's own dev script, which chooses its own port and ignores argv, so accepting the flag there would report a port the server never binds.

A malformed value (`--port` with nothing after it, a non-number, or one outside `1`-`65535`) exits `2` without starting anything.

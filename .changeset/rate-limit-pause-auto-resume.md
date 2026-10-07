---
'@attalabs/vinaya': patch
---

A round paused by a GitHub rate limit now resumes by itself once the limit has reset: the driver that is watching the pause reads the reset time once (without spending the limit), sleeps until then plus a short margin, and resumes the same round through the ordinary resume path, so no finished role runs twice. After two automatic resumes of one round that each pause on the limit again, the pause stays and its comment says a plain resume clears it. Pauses for any other reason are watched as before.

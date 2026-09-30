---
'@attalabs/vinaya': patch
---

`vinaya log set-credential` now actually stores the credential instead of silently storing nothing.

The store ran `security add-generic-password … -w` with `-w` last and empty and the value piped to stdin. But `-w` last means "prompt for the password", which `security` reads from the terminal, not standard input — so with no terminal the command exited 0 and stored nothing, printing a success confirmation for a credential that was never written; from an interactive terminal it stalled at the `password data for new item:` prompt.

The value now reaches `security` only through the standard-input command stream of `security -i`, hex-encoded with `-X`, so it is never a `security` argument a `ps` listing could show and no space, quote or backslash in it can alter how `security -i` parses the store command. Because `security -i` reports success even when the write did not happen, the store then confirms by reading the item back and fails loudly — exit non-zero, naming the variable and never the value — unless the stored item equals the value given. The read path (`find-generic-password -w`) that `logs.headers` resolution already uses is unchanged. A macOS-only test drives the real `/usr/bin/security` against a throwaway keychain file (never the login keychain) to prove the round trip, the argument list, and the read-back gate; it is skipped on other platforms.

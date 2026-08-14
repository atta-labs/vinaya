# Self-hosting — how Vinaya governs a repo that contains Vinaya

Status: draft

The generated CI shape for a repo whose own workspaces declare `@attalabs/vinaya`, why it must differ, and what it costs. This repo is the first such adopter; the rules below are the product's, not this repo's.

## The failure it exists to prevent

`init` and `upgrade` generate four workflows, each invoking the published package as `npx --yes @attalabs/vinaya`. In a repo whose root `workspaces` globs reach a member declaring that exact name, npm never contacts the registry. It matches on the package **name**, before any version spec is read, resolves that member's declared `bin`, and execs a file nothing has built:

```
sh: vinaya: command not found
```

Two consequences follow, and both have been measured rather than reasoned about:

- **Pinning a version cannot fix it.** Every spec form — `@0.4.6`, `@latest`, a tag — is decided after the name match. The name is what npm branches on.
- **Publishing cannot fix it either.** The workflow files are already committed in the adopter's repo. Only a new publish *plus* `vinaya upgrade` rewrites them.

## The two shapes

Detection runs at **generation time** — `init`, `upgrade` and `doctor` all hold the repo root — so the emitted YAML carries no branching logic of its own.

| | ordinary adopter | vendoring repo |
|---|---|---|
| detection | no workspace member named `@attalabs/vinaya` | such a member exists |
| setup | `actions/setup-node` | `actions/setup-node` + `oven-sh/setup-bun` |
| build | none | `bun install --frozen-lockfile`, `bun run --cwd <member> build` |
| invocation | `npx --yes @attalabs/vinaya <cmd>` | `node <member>/<bin> <cmd>` |

The ordinary-adopter output is **byte-identical to the pre-detection generator**. This is the load-bearing property: the overwhelming majority of adopters have no local copy to build and must not pay for a problem they do not have.

**The predicate is exactly the misresolution condition** — a workspace member whose `package.json` `name` is `@attalabs/vinaya` — and deliberately nothing more. Not "has a build script", not "is called `apps/cli`". A repo that declares the name is one where `npx` is already broken; narrowing further would hand it an invocation that cannot work, and widening it would give an ordinary adopter a build step it does not need.

Generation-time detection is also what keeps `doctor` honest. `doctor` diffs regenerated content against what is on disk to report drift, and a pure function of the repo's on-disk workspace declaration regenerates the same bytes for the same repo. A runtime branch inside the YAML would not have that property, and logic living in YAML is logic the unit tests cannot execute.

## Emitted paths are allowlisted, not escaped

The member's directory and its `bin` path are interpolated into a workflow `run:` scalar as **bare, unquoted shell words**, and both originate in the *target repo's* `package.json` — content the CLI does not control. This generator writes CI configuration into other people's repositories, so the values it embeds are constrained rather than sanitized:

```
^[A-Za-z0-9@._-]+(?:/[A-Za-z0-9@._-]+)*$
```

with three further rules on each segment: `.` and `..` are rejected as whole segments, and no segment may begin with `-`. Anything outside this makes detection return `null`.

`@` is permitted because npm scopes are ordinary directory names — a member at `packages/@attalabs/vinaya` is legitimate, and excluding it would silently degrade exactly the repo this feature exists for into the invocation already known broken there. It is inert in all three layers of the emitted context: it is a YAML indicator only at the start of a plain scalar, which it can never reach (the invocation is always prefixed by `node `, and the `--cwd` line sits inside a literal block); it is a non-globbing literal to `sh`, `bash` and `zsh`; and no Actions expression can form, since `$` and `{` remain excluded.

A leading `-` is refused for the opposite reason: it reaches `node` and `bun` in argument position, where a segment named `-e` or `--eval` is read as an option rather than a path.

**State the reason precisely, because the intuitive version is backwards.** Both runtimes *execute* a detached value — `node -e 'code'` and `bun -e 'code'` both run the code. What they reject is the attached form: `node -e/dist/index.js` and `node -e=/dist/index.js` are both `node: bad option`. The emitted `node <bin>` invocation is safe only because the interpolated path is always a single argv token, and `=` is outside the allowed charset — two separate exclusions, not one.

That invariant does not hold everywhere the values are emitted. `bun run --cwd <dir> build` **already passes the path as its own token**, and bun binds it to `--cwd` unconditionally: with the directory present, `--cwd -e`, `--cwd --eval`, `--cwd --help` all simply build there. That case is safe for a different reason — bun treats the token as a value, not an option — so the leading-`-` rule is what keeps both emissions honest rather than an optimisation on either.

The refusal is therefore not "this would be harmless anyway". It is: no real directory needs a leading `-`, and the property standing between a parse error and `-e` is one nothing else enforces.

Allowlist rather than escaping, for two reasons. Escaping must be correct against every metacharacter, in a `run:` block that is simultaneously YAML, shell, and a GitHub Actions expression context — three layers, each with its own evaluation rules. And a value outside this charset has no legitimate use as a workspace path, so refusing costs nothing real.

`null` is already the safe default: a rejected value degrades to the published `npx` shape, which is wrong for that repo but harmless there, rather than failing `init`. The same rule closes traversal — a `workspaces` pattern reaching outside the repo root produces a path containing `..`, which is refused.

Detection never throws. A missing, unreadable or malformed root `package.json` degrades to `null`; a broken manifest must not take down `vinaya init`. Glob expansion skips `node_modules` and dot-directories, sorts children for determinism, and caps candidate directories.

## What self-hosting costs, stated plainly

A repo on the vendored shape runs the CLI **from its own working tree**. Its CI therefore exercises the code in the pull request rather than a published copy predating it — normally an improvement, and the reason to prefer this shape even where `npx` would work.

The cost is on the same fact. **A pull request that edits this package's check sources changes the checks that judge it.** A PR can leave every generated step intact and still make its own required check report green.

This does not weaken any claim about a *published* Vinaya: an ordinary adopter's CI runs an immutable artifact the PR cannot reach, and that guarantee is unchanged. But `enforcement.md`'s account of ring-1 enforcement — that a required check under branch protection cannot be bypassed — holds for the adopter case and not for the vendoring one. Branch protection closes step deletion; it does not close this.

The mitigation is not technical. A repo that vendors the CLI is governing itself, and the reviewer of a PR touching `src/checks/**` is the last line: check-source changes in such a repo are reviewed as governance changes, not as ordinary code.

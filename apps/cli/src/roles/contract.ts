/**
 * Structural validation for a role contract's markdown — the same "structural,
 * not semantic" discipline the checks resolver applies to a `CheckEntry`:
 * this proves the SHAPE a role doc must carry to be resolvable (which
 * frontmatter keys exist, what type each is, that the body carries a
 * non-empty "## The short version" section), never whether its prose is
 * good doctrine. That judgment stays a review concern.
 *
 * Pure — no `fs`, no `@attalabs/aeg-core` import — mirrors
 * `../checks/contract.ts`'s own "pure contract" discipline and
 * `../checks/resolver.ts`'s doc comment. The caller reads the file; this
 * module only parses the string it hands over.
 */
import matter from 'gray-matter'

export type RoleActor = 'agent' | 'human' | 'either'

/** The eight structural fields a resolvable role contract must carry — six frontmatter keys beyond `title`/`order`, which are counted separately because every downstream consumer (rendering, ordering) reads them as their own concern. */
export type RoleContract = {
  roleId: string
  title: string
  order: number
  description: string
  actor: RoleActor
  performs: string[]
  refusesWhen: string
  summary: string
}

export type RoleContractValidation = { ok: true; contract: RoleContract } | { ok: false; errors: string[] }

const SHORT_VERSION_HEADING = /^##\s*The short version\s*$/m

/**
 * Is the "## The short version" section non-empty? Scans from the heading
 * line to the next `##`-or-shallower heading (or EOF), and asks whether any
 * line in between carries non-whitespace text. A heading with nothing under
 * it (or only blank lines) fails the same way a missing heading does — an
 * empty section tells a reader nothing.
 */
function hasNonEmptyShortVersion(body: string): boolean {
  const lines = body.split('\n')
  const headingIndex = lines.findIndex((line) => SHORT_VERSION_HEADING.test(line))
  if (headingIndex === -1) return false
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^#{1,2}\s/.test(line)) break
    if (line.trim().length > 0) return true
  }
  return false
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

/**
 * Validates one role contract's markdown content against the structural
 * shape every resolvable role — core, override, or additive — must carry:
 * `role_id`, `description`, `actor`, `performs`, `refuses_when`, `summary`
 * in frontmatter (six keys), plus `title` and `order` (two more, counted
 * separately per the frozen spec's own accounting), plus a non-empty
 * "## The short version" body section. Collects every violation rather than
 * failing on the first, so a malformed contract's diagnostic names every
 * problem at once.
 */
export function validateRoleContract(content: string): RoleContractValidation {
  const { data, content: body } = matter(content)
  const errors: string[] = []

  const roleId = typeof data.role_id === 'string' && data.role_id.length > 0 ? data.role_id : undefined
  if (roleId === undefined) errors.push('frontmatter is missing a non-empty "role_id" (string)')

  const title = typeof data.title === 'string' && data.title.length > 0 ? data.title : undefined
  if (title === undefined) errors.push('frontmatter is missing a non-empty "title" (string)')

  const order = typeof data.order === 'number' ? data.order : undefined
  if (order === undefined) errors.push('frontmatter is missing a numeric "order"')

  const description = typeof data.description === 'string' && data.description.length > 0 ? data.description : undefined
  if (description === undefined) errors.push('frontmatter is missing a non-empty "description" (string)')

  const actor =
    data.actor === 'agent' || data.actor === 'human' || data.actor === 'either' ? (data.actor as RoleActor) : undefined
  if (actor === undefined) errors.push('frontmatter "actor" must be one of "agent" | "human" | "either"')

  const performs = isStringArray(data.performs) ? data.performs : undefined
  if (performs === undefined) errors.push('frontmatter is missing "performs" (array of strings)')

  const refusesWhen =
    typeof data.refuses_when === 'string' && data.refuses_when.length > 0 ? data.refuses_when : undefined
  if (refusesWhen === undefined) errors.push('frontmatter is missing a non-empty "refuses_when" (string)')

  const summary = typeof data.summary === 'string' && data.summary.length > 0 ? data.summary : undefined
  if (summary === undefined) errors.push('frontmatter is missing a non-empty "summary" (string)')

  if (!hasNonEmptyShortVersion(body)) {
    errors.push('body is missing a non-empty "## The short version" section')
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    contract: {
      roleId: roleId as string,
      title: title as string,
      order: order as number,
      description: description as string,
      actor: actor as RoleActor,
      performs: performs as string[],
      refusesWhen: refusesWhen as string,
      summary: summary as string
    }
  }
}

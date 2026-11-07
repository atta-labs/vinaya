/**
 * The seam the pure derivation (`deriveDiagramModel`) consumes doctrine
 * through, instead of reading `harness/processes/vinaya-strict/` paths directly. Doctrine is the raw
 * markdown that governs the methodology — `enforcement.md`, the role files,
 * the contract files. Implementations (file-backed today, package-bundled for
 * adopters tomorrow) perform I/O and therefore live outside `aeg-core`
 * (`apps/vinaya/sources`) — this package only defines the contract, so the
 * library can be packaged for repos that have no `harness/processes/vinaya-strict/` of their own
 *. Same discipline as `state-source.ts`: zero I/O here, async on the
 * adapter so callers get one uniform type regardless of the backing store.
 */
import { CONTRACT_ENTRIES, doctrineSource, ROLE_KEY_ENTRIES } from './doctrine/doctrine-map'

/** One doctrine file of the content below: the logical key it is reported by, and its source path under a doctrine root. */
export type DoctrineContentFile = { key: string; source: string }

/**
 * Where each part of `DoctrineContent` lives under a doctrine root, read from
 * the doctrine map: the enforcement page's source path, and the role doctrine
 * and contracts each by logical key and source path, in logical-key order.
 */
export const DOCTRINE_CONTENT_LAYOUT: {
  enforcement: string
  roles: readonly DoctrineContentFile[]
  contracts: readonly DoctrineContentFile[]
} = {
  enforcement: doctrineSource('enforcement.md'),
  roles: [...ROLE_KEY_ENTRIES].sort((a, b) => a.key.localeCompare(b.key)).map(({ key, source }) => ({ key, source })),
  contracts: [...CONTRACT_ENTRIES]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ key, source }) => ({ key, source }))
}

export type DoctrineContent = {
  /** Raw `enforcement.md` content. */
  enforcement: string
  /** Raw `roles/*.md` files (path + content). */
  roles: Array<{ path: string; content: string }>
  /** Raw `contracts/*.md` files (path + content). */
  contracts: Array<{ path: string; content: string }>
}

export type DoctrineSource = {
  getDoctrine(): Promise<DoctrineContent>
}

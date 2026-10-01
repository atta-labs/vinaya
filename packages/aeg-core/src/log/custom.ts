/**
 * Consumer-declared log events — the pure half. A repository declares its
 * own events under `vinaya.config.json`'s `logs.events` (`apps/cli/specs/log.md`
 * § Custom events); this module holds the declaration rules the config
 * loader applies and the value check the writer applies before one
 * `custom` line is written. No filesystem, network or process access here —
 * the writer (`apps/cli/src/lib/log-custom.ts`) reads the declarations and
 * calls `log()`.
 *
 * A declaration names each field's type: `"text"`, `"number"`, `"boolean"`
 * (yes/no), or a list of words the value must be one of. Every declared
 * field is required; nested values and lists are never a field value.
 */

import { z } from 'zod'

/** `<namespace>.<event>` — lowercase, a namespace, a dot, then the event (which may itself carry dots). */
export const CUSTOM_EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/
export const CUSTOM_EVENT_NAME_MAX_LENGTH = 64
/** The namespace Vinaya's own events live in; a consumer can never declare a name in it. */
export const CUSTOM_EVENT_RESERVED_NAMESPACE = 'vinaya'
export const CUSTOM_EVENT_MAX_FIELDS = 20
export const CUSTOM_FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]*$/
export const CUSTOM_FIELD_NAME_MAX_LENGTH = 64
export const CUSTOM_TEXT_MAX_LENGTH = 500
/** A listed word: lowercase letters, digits, `_` and `-`, starting with a letter or digit. */
export const CUSTOM_WORD_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
export const CUSTOM_WORD_MAX_LENGTH = 64
export const CUSTOM_FIELD_MAX_WORDS = 50
/** Stands in, in a refusal, for a given field name not shaped like one. */
export const UNRECORDABLE_FIELD_NAME = '<unrecordable>'

export type CustomFieldType = 'text' | 'number' | 'boolean' | string[]
export type CustomEventDeclaration = { fields: Record<string, CustomFieldType> }
export type CustomEventDeclarations = Record<string, CustomEventDeclaration>
/** One field's value as a `custom` line carries it — flat, never nested. */
export type CustomFieldValue = string | number | boolean

const CustomFieldTypeSchema = z.union([z.enum(['text', 'number', 'boolean']), z.array(z.string())])

/**
 * `logs.events` — every rule a declaration must satisfy, checked at config
 * load. Each refusal message names the event (and the field, when one is at
 * fault), so a broken entry is found without reading the schema.
 */
export const CustomEventDeclarationsSchema = z
  .record(
    z.string(),
    z
      .object({
        fields: z.record(z.string(), CustomFieldTypeSchema)
      })
      .strict()
  )
  .superRefine((events, ctx) => {
    for (const [name, declaration] of Object.entries(events)) {
      const refuse = (message: string, path: (string | number)[] = []): void => {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name, ...path],
          message: `logs.events "${name}": ${message}`
        })
      }
      if (name.length > CUSTOM_EVENT_NAME_MAX_LENGTH) {
        refuse(`the name must be at most ${CUSTOM_EVENT_NAME_MAX_LENGTH} characters`)
      }
      if (!CUSTOM_EVENT_NAME_PATTERN.test(name)) {
        refuse('the name must be `<namespace>.<event>` — lowercase letters, digits and `_`, a dot between them')
      } else if (name.split('.')[0] === CUSTOM_EVENT_RESERVED_NAMESPACE) {
        refuse(`the \`${CUSTOM_EVENT_RESERVED_NAMESPACE}.\` namespace is reserved for Vinaya's own events`)
      }
      const fieldEntries = Object.entries(declaration.fields)
      if (fieldEntries.length > CUSTOM_EVENT_MAX_FIELDS) {
        refuse(`at most ${CUSTOM_EVENT_MAX_FIELDS} fields may be declared (found ${fieldEntries.length})`, ['fields'])
      }
      for (const [field, type] of fieldEntries) {
        if (field.length > CUSTOM_FIELD_NAME_MAX_LENGTH || !CUSTOM_FIELD_NAME_PATTERN.test(field)) {
          refuse(
            `field "${field}": a field name is lowercase letters, digits and \`_\`, starting with a letter, at most ${CUSTOM_FIELD_NAME_MAX_LENGTH} characters`,
            ['fields', field]
          )
        }
        if (typeof type === 'string') continue
        if (type.length === 0) {
          refuse(`field "${field}": a list of words must name at least one word`, ['fields', field])
        }
        if (type.length > CUSTOM_FIELD_MAX_WORDS) {
          refuse(`field "${field}": a list of words may name at most ${CUSTOM_FIELD_MAX_WORDS}`, ['fields', field])
        }
        const bad = type.filter((w) => w.length > CUSTOM_WORD_MAX_LENGTH || !CUSTOM_WORD_PATTERN.test(w))
        if (bad.length > 0) {
          refuse(
            `field "${field}": a listed word is lowercase letters, digits, \`_\` and \`-\`, at most ${CUSTOM_WORD_MAX_LENGTH} characters`,
            ['fields', field]
          )
        }
        if (new Set(type).size !== type.length) {
          refuse(`field "${field}": a list of words names a word twice`, ['fields', field])
        }
      }
    }
  })

/**
 * Why a `custom` event was refused. `undeclared` — the name is not in
 * `logs.events`; `missing_field` — a declared field was not given;
 * `extra_field` — a field was given that the declaration does not name;
 * `wrong_type` — a value is not of its declared type (a nested value or a
 * list included); `too_long` — a text value is longer than the limit.
 */
export type CustomEventRefusalReason = 'undeclared' | 'missing_field' | 'extra_field' | 'wrong_type' | 'too_long'

export type CustomEventCheck =
  | { ok: true; name: string; fields: Record<string, CustomFieldValue> }
  | { ok: false; reason: CustomEventRefusalReason; fieldNames: string[] }

function valueMatches(type: CustomFieldType, value: unknown): boolean {
  if (type === 'text') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  return typeof value === 'string' && type.includes(value)
}

/**
 * Checks one event against the declarations. The first failing class wins,
 * in this order: undeclared, missing, extra, wrong type, too long — and the
 * refusal names every field in that class, sorted, never a value.
 */
export function checkCustomEvent(
  declarations: CustomEventDeclarations,
  name: string,
  fields: Readonly<Record<string, unknown>>
): CustomEventCheck {
  const declaration = Object.hasOwn(declarations, name) ? declarations[name] : undefined
  if (declaration === undefined) return { ok: false, reason: 'undeclared', fieldNames: [] }
  const declared = declaration.fields
  const given = Object.keys(fields)
  const missing = Object.keys(declared).filter((f) => !Object.hasOwn(fields, f))
  if (missing.length > 0) return { ok: false, reason: 'missing_field', fieldNames: missing.sort() }
  const extra = given.filter((f) => !Object.hasOwn(declared, f))
  if (extra.length > 0) {
    // An undeclared name comes from the caller, not the declaration, and could
    // itself be a value pasted in the wrong place — only a name shaped like a
    // field name is recorded as given.
    const named = extra.map((f) =>
      f.length <= CUSTOM_FIELD_NAME_MAX_LENGTH && CUSTOM_FIELD_NAME_PATTERN.test(f) ? f : UNRECORDABLE_FIELD_NAME
    )
    return { ok: false, reason: 'extra_field', fieldNames: named.sort().slice(0, CUSTOM_EVENT_MAX_FIELDS) }
  }
  const wrong = given.filter((f) => !valueMatches(declared[f] as CustomFieldType, fields[f]))
  if (wrong.length > 0) return { ok: false, reason: 'wrong_type', fieldNames: wrong.sort() }
  const long = given.filter(
    (f) => typeof fields[f] === 'string' && (fields[f] as string).length > CUSTOM_TEXT_MAX_LENGTH
  )
  if (long.length > 0) return { ok: false, reason: 'too_long', fieldNames: long.sort() }
  return { ok: true, name, fields: { ...fields } as Record<string, CustomFieldValue> }
}

/**
 * Vinaya's launched roles: the role folders `process.yaml` declares under `roles`, by name, in the order the
 * executing actions iterate them. Typed as plain strings so a caller can check any role name against it.
 */
export const VINAYA_LAUNCHED_ROLES: readonly string[] = ['developer', 'code-reviewer', 'security-reviewer']

/** Studio's screens, in the order the header shows them. Mission Control is the landing screen, at `/`. */
export const STUDIO_SCREENS = [
  { label: 'Milestones', href: '/milestones' },
  { label: 'Tasks', href: '/tasks' },
  { label: 'Mission Control', href: '/' }
] as const

/** Whether `pathname` is on `href`'s screen: the landing screen matches only `/`, the others their own subtree. */
export function isOnScreen(pathname: string | null, href: string): boolean {
  if (!pathname) return false
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)
}

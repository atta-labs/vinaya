import { iconForName } from './registry'

/** The icon beside a product, agent or subject name; nothing for a name with no drawing. */
export function NamedIcon({ name, className, still }: { name: string; className?: string; still?: boolean }) {
  const Icon = iconForName(name)
  return Icon ? <Icon className={className} still={still} /> : null
}

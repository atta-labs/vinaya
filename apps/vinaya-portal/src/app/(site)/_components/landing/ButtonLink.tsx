'use client'

import Link from 'next/link'
import type { ComponentProps } from 'react'
import { buttonVariants } from '@/ui/components'
import { cn } from '@/ui/lib/utils'

// buttonVariants() is exported alongside a 'use client' component (animate's Button), so
// it can only be CALLED from client code — a Server Component may render <Button> but not
// invoke buttonVariants() directly. This wrapper is the client boundary that isolates that
// call; a plain <Link> styled with it never routes through Slot/motion.create the way
// <Button asChild> does, so it doesn't inherit that component's dev-mode instability either.
export function ButtonLink({
  variant = 'default',
  size = 'lg',
  className,
  ...props
}: ComponentProps<typeof Link> & {
  variant?: 'default' | 'secondary' | 'outline' | 'inverse' | 'inverse-outline'
  size?: 'default' | 'sm' | 'lg' | 'xl' | 'icon'
}) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

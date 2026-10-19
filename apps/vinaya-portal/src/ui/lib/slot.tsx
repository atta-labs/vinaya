'use client'

import { Role } from '@ariakit/react'
import * as React from 'react'

// `asChild` on top of Ariakit's `render` prop: the single element child becomes
// the rendered element, and Ariakit merges our props (className, handlers, ref)
// into it.
export function singleChild(children: React.ReactNode): React.ReactElement | undefined {
  if (React.isValidElement(children)) return children
  return React.Children.toArray(children).find(React.isValidElement) as React.ReactElement | undefined
}

/** What an `asChild`/`render` pair resolves to as an Ariakit `render` value. */
export function resolveRender(
  asChild: boolean | undefined,
  children: React.ReactNode,
  render?: React.ReactElement
): React.ReactElement | undefined {
  return render ?? (asChild ? singleChild(children) : undefined)
}

export function Slot({
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode; ref?: React.Ref<HTMLElement> }) {
  const child = singleChild(children)
  if (!child) return null
  return <Role render={child} {...(props as React.HTMLAttributes<HTMLDivElement>)} />
}

'use client'

import { Role } from '@ariakit/react'
import { ChevronRight, MoreHorizontal } from 'lucide-react'
import type * as React from 'react'
import { singleChild } from '../lib/slot'
import { cn } from '../lib/utils'

function Breadcrumb(props: React.ComponentProps<'nav'> & { separator?: React.ReactNode }) {
  const { separator: _separator, ...rest } = props
  return <nav aria-label='breadcrumb' data-slot='breadcrumb' {...rest} />
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<'ol'>) {
  return (
    <ol
      data-slot='breadcrumb-list'
      className={cn(
        'flex flex-wrap items-center gap-1.5 break-words text-sm text-muted-foreground sm:gap-2.5',
        className
      )}
      {...props}
    />
  )
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<'li'>) {
  return <li data-slot='breadcrumb-item' className={cn('inline-flex items-center gap-1.5', className)} {...props} />
}

function BreadcrumbLink({ asChild, className, children, ...props }: React.ComponentProps<'a'> & { asChild?: boolean }) {
  const classes = cn('transition-colors hover:text-foreground', className)
  const child = asChild ? singleChild(children) : undefined
  if (child)
    return (
      <Role
        render={child}
        data-slot='breadcrumb-link'
        className={classes}
        {...(props as React.HTMLAttributes<HTMLElement>)}
      />
    )
  return (
    <a data-slot='breadcrumb-link' className={classes} {...props}>
      {children}
    </a>
  )
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<'span'>) {
  // shadcn's canonical current-page crumb: a disabled link, read as the page you are on.
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: the current page is deliberately not focusable
    // biome-ignore lint/a11y/useSemanticElements: an <a> without href is the same thing, less explicit
    <span
      data-slot='breadcrumb-page'
      role='link'
      aria-disabled='true'
      aria-current='page'
      className={cn('font-normal text-foreground', className)}
      {...props}
    />
  )
}

function BreadcrumbSeparator({ children, className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot='breadcrumb-separator'
      role='presentation'
      aria-hidden='true'
      className={cn('[&>svg]:h-3.5 [&>svg]:w-3.5', className)}
      {...props}
    >
      {children ?? <ChevronRight />}
    </li>
  )
}

function BreadcrumbEllipsis({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot='breadcrumb-ellipsis'
      role='presentation'
      aria-hidden='true'
      className={cn('flex h-9 w-9 items-center justify-center', className)}
      {...props}
    >
      <MoreHorizontal className='h-4 w-4' />
      <span className='sr-only'>More</span>
    </span>
  )
}

export {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
}

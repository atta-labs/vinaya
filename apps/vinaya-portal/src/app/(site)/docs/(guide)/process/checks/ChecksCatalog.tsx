'use client'

import { useState } from 'react'
import { CHECKS, type CheckRow } from '@/content/checks'
import { Button, Code, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/components'
import { NextLink } from '@/ui/lib/next-link'

const STAGES: CheckRow['stage'][] = ['Commit', 'Push', 'Pull request', 'Issue write']
const KINDS = ['Generic gate', 'Vinaya-specific'] as const
type Kind = (typeof KINDS)[number]

const kindOf = (c: CheckRow): Kind => (c.implements === 'Vinaya' ? 'Vinaya-specific' : 'Generic gate')

/** A row of filter buttons; clicking the active one clears it. */
function Filter<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string
  options: readonly T[]
  value: T | null
  onChange: (v: T | null) => void
}) {
  return (
    <div className='flex flex-wrap items-center gap-2'>
      <span className='w-24 font-mono text-xs uppercase tracking-widest text-muted-foreground'>{label}</span>
      {options.map((o) => (
        <Button
          key={o}
          size='sm'
          variant={value === o ? 'secondary' : 'subtle'}
          hoverScale={1}
          tapScale={1}
          aria-pressed={value === o}
          onClick={() => onChange(value === o ? null : o)}
        >
          {o}
        </Button>
      ))}
    </div>
  )
}

/** All 37 core checks, filterable by where they first run and by whether they implement a generic gate. */
export function ChecksCatalog() {
  const [stage, setStage] = useState<CheckRow['stage'] | null>(null)
  const [kind, setKind] = useState<Kind | null>(null)
  const rows = CHECKS.filter((c) => (!stage || c.stage === stage) && (!kind || kindOf(c) === kind))
  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-col gap-2'>
        <Filter label='First runs' options={STAGES} value={stage} onChange={setStage} />
        <Filter label='Kind' options={KINDS} value={kind} onChange={setKind} />
      </div>
      <p className='text-sm text-muted-foreground'>
        {rows.length} of {CHECKS.length} checks
      </p>
      <Table stickyHeader variant='docs' containerClassName='@min-[780px]/tbl:[&_thead_th]:top-0'>
        <TableHeader>
          <TableRow>
            <TableHead className='whitespace-nowrap'>Check</TableHead>
            <TableHead className='whitespace-nowrap'>Refuses</TableHead>
            <TableHead className='whitespace-nowrap'>First runs</TableHead>
            <TableHead className='whitespace-nowrap'>Implements</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => (
            <TableRow key={c.name}>
              <TableCell>
                <NextLink variant='unstyled' href={c.href}>
                  <Code className='text-[0.85em] underline-offset-4 hover:underline'>{c.name}</Code>
                </NextLink>
              </TableCell>
              <TableCell className='whitespace-normal'>{c.refuses.replace(/`/g, '')}</TableCell>
              <TableCell>{c.stage}</TableCell>
              <TableCell className='whitespace-normal'>
                {c.implements === 'Vinaya' ? 'Vinaya-specific' : c.implements}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

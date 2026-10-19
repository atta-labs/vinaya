import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/components'
import { toneText } from '../tone'
import type { Tone } from '../types'

type StudioRow = {
  task: string
  issue: number
  pr: string
  state: string
  round: string
  phase: string
  gate: string
}

/** Mission Control, mocked: the rows Studio would show for this moment. */
export function StudioTable({ rows, tone }: { rows: StudioRow[]; tone: Tone }) {
  return (
    <div className='overflow-x-auto'>
      <Table variant='data'>
        <TableHeader>
          <TableRow>
            {['Task', 'Issue', 'PR', 'State', 'Round', 'Phase', 'Gate'].map((h) => (
              <TableHead key={h}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.issue}>
              <TableCell>{r.task}</TableCell>
              <TableCell>#{r.issue}</TableCell>
              <TableCell>{r.pr}</TableCell>
              <TableCell className={toneText[tone]}>{r.state}</TableCell>
              <TableCell>{r.round}</TableCell>
              <TableCell>{r.phase}</TableCell>
              <TableCell>{r.gate}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

import { Card, Heading, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Text } from '@vinaya/ui'

/** The board's columns, left to right; the rows arrive with the board itself. */
const BOARD_COLUMNS = ['State', 'Task', 'Rounds', 'Pull request', 'Last sign'] as const

/**
 * Mission Control, Studio's landing screen: the board's empty frame — its header with the repository and the
 * branch, the counts bar and the task list. Nothing is read yet, so the repository and the branch show as unknown
 * and the bar and the list are empty.
 */
export default function MissionControlPage() {
  return (
    <section className='flex flex-col gap-6'>
      <header className='flex flex-wrap items-baseline justify-between gap-4'>
        <Heading level={1} size='2xl'>
          Mission Control
        </Heading>
        <div className='flex gap-6'>
          <div className='flex gap-2'>
            <Text as='span' size='sm' tone='muted'>
              Repository
            </Text>
            <Text as='span' size='sm' family='mono' data-board-field='repository'>
              unknown
            </Text>
          </div>
          <div className='flex gap-2'>
            <Text as='span' size='sm' tone='muted'>
              Branch
            </Text>
            <Text as='span' size='sm' family='mono' data-board-field='branch'>
              unknown
            </Text>
          </div>
        </div>
      </header>
      <Card variant='flat' aria-label='Task counts' data-board-part='counts' className='px-4 py-3'>
        <Text size='sm' tone='muted'>
          No tasks to count yet.
        </Text>
      </Card>
      <Card variant='flat' data-board-part='list'>
        <Table aria-label='Tasks'>
          <TableHeader>
            <TableRow>
              {BOARD_COLUMNS.map((column) => (
                <TableHead key={column}>{column}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell colSpan={BOARD_COLUMNS.length}>
                <Text size='sm' tone='muted'>
                  No tasks yet.
                </Text>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>
    </section>
  )
}

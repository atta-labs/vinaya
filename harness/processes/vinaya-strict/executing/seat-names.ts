import type { SeatNames } from '@attalabs/vinaya-log-sdk'
import { lookupRole, registeredRoles } from '../../../kernel/log/roles'

/** The seats the process registered, as the Log SDK's narration reads them: a reading name, and whether the seat reviews. */
export function registeredSeatNames(): SeatNames {
  const seats: Record<string, { reading: string; reviews: boolean }> = {}
  for (const name of registeredRoles()) {
    const role = lookupRole(name)
    if (role !== undefined) seats[name] = { reading: role.reading, reviews: role.reviews }
  }
  return seats
}

import { MissionControlLiveList } from '@/ui/mission-control/live-list'

/**
 * Mission Control, Studio's landing screen: the minimal live task list. The server renders the connecting frame; the
 * list fills in once the browser opens the application WebSocket with the session it already holds.
 */
export default function MissionControlPage() {
  return <MissionControlLiveList />
}

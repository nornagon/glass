import type { AutomergeUrl } from '@automerge/react'
import { useRoomHash } from './app/hash'
import { RoomScreen } from './app/RoomScreen'

export default function App({ initialRoomUrl }: { initialRoomUrl: AutomergeUrl }) {
  const roomUrl = useRoomHash(initialRoomUrl)
  return <RoomScreen roomUrl={roomUrl} />
}

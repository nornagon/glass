import { useRoomHash } from './app/hash'
import { LandingScreen } from './app/LandingScreen'
import { RoomScreen } from './app/RoomScreen'

export default function App() {
  const roomUrl = useRoomHash()

  if (!roomUrl) {
    return <LandingScreen />
  }

  return <RoomScreen roomUrl={roomUrl} />
}

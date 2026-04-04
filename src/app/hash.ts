import { useEffect, useState } from 'react'
import type { AutomergeUrl } from '@automerge/react'
import { parseRoomUrlFromHash } from '../model/repo'

export function useRoomHash() {
  const [roomUrl, setRoomUrl] = useState<AutomergeUrl | undefined>(() => parseRoomUrlFromHash())

  useEffect(() => {
    const onHashChange = () => {
      setRoomUrl(parseRoomUrlFromHash())
    }

    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return roomUrl
}

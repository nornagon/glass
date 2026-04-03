import { useEffect, useState } from 'react'
import type { AutomergeUrl } from '@automerge/react'
import { parseRoomUrlFromHash } from '../model/repo'

export function useRoomHash(initialRoomUrl: AutomergeUrl) {
  const [roomUrl, setRoomUrl] = useState<AutomergeUrl>(parseRoomUrlFromHash() ?? initialRoomUrl)

  useEffect(() => {
    const onHashChange = () => {
      const next = parseRoomUrlFromHash()
      if (next) {
        setRoomUrl(next)
      }
    }

    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return roomUrl
}

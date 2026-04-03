/// <reference lib="WebWorker" />

import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{
    url: string
    revision: string | null
  }>
}

self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener('message', (event) => {
  if (event.data?.type === 'TURN_BADGE_STATE') {
    const active = Boolean(event.data.payload?.active)
    const registrationWithBadge = self.registration as ServiceWorkerRegistration & {
      setAppBadge?: (value?: number) => Promise<void>
      clearAppBadge?: () => Promise<void>
    }

    if (active && registrationWithBadge.setAppBadge) {
      void registrationWithBadge.setAppBadge(1)
    } else if (!active && registrationWithBadge.clearAppBadge) {
      void registrationWithBadge.clearAppBadge()
    }
  }

  if (event.data?.type === 'LOCAL_TURN_NOTIFICATION' && Notification.permission === 'granted') {
    void self.registration.showNotification('Your turn in Glass', {
      body: event.data.payload?.body ?? 'The active turn marker moved to you.',
      tag: 'glass-turn',
      badge: '/icon.svg',
      icon: '/icon.svg',
    })
  }
})

export async function syncTurnBadge(isActive: boolean) {
  const navigatorWithBadge = navigator as Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }

  try {
    if (isActive && navigatorWithBadge.setAppBadge) {
      await navigatorWithBadge.setAppBadge(1)
    } else if (!isActive && navigatorWithBadge.clearAppBadge) {
      await navigatorWithBadge.clearAppBadge()
    }
  } catch {
    // Badging is best-effort in the prototype.
  }

  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'TURN_BADGE_STATE',
      payload: { active: isActive },
    })
  }
}

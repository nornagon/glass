async (page) => {
  const roomUrl = page.url()
  if (!roomUrl) {
    throw new Error('Open the room page before running the zoom perf harness')
  }

  await page.goto(roomUrl, { waitUntil: 'domcontentloaded' })

  const loadStats = await page.evaluate(async () => {
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    const waitMs = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
    const MIN_EXPECTED_IMAGES = 20
    const MAX_IMAGE_WAIT_MS = 30000

    await waitMs(250)
    await nextFrame()

    await new Promise((resolve, reject) => {
      let elapsed = 0
      const poll = () => {
        if (document.querySelectorAll('[data-board-object-id]').length > 20) {
          resolve(undefined)
          return
        }

        elapsed += 50
        if (elapsed >= 15000) {
          reject(new Error('Board objects did not load in time'))
          return
        }
        window.setTimeout(poll, 50)
      }
      poll()
    })

    let stableImageCount = 0
    let previousImageCount = -1
    let elapsed = 0
    while (elapsed < MAX_IMAGE_WAIT_MS && stableImageCount < 8) {
      const images = [...document.querySelectorAll('.board-sprite-image')]
      const imageCount = images.length
      const incompleteCount = images.filter((element) => (
        !(element instanceof HTMLImageElement) ||
        !element.complete ||
        element.naturalWidth <= 0 ||
        element.naturalHeight <= 0
      )).length

      if (imageCount >= MIN_EXPECTED_IMAGES && incompleteCount === 0 && imageCount === previousImageCount) {
        stableImageCount += 1
      } else {
        stableImageCount = 0
        previousImageCount = imageCount
      }

      await waitMs(100)
      await nextFrame()
      elapsed += 100
    }

    const images = [...document.querySelectorAll('.board-sprite-image')]
    if (images.length < MIN_EXPECTED_IMAGES) {
      throw new Error(`Expected at least ${MIN_EXPECTED_IMAGES} sprite images before measuring, found ${images.length}`)
    }

    await Promise.all(
      images.map(async (element) => {
        const image = element
        if (!(image instanceof HTMLImageElement)) {
          return
        }

        if (!image.complete) {
          await new Promise((resolve) => {
            image.addEventListener('load', () => resolve(undefined), { once: true })
            image.addEventListener('error', () => resolve(undefined), { once: true })
          })
        }

        if (typeof image.decode === 'function') {
          try {
            await image.decode()
          } catch {
            // ignore decode failures; complete/error above is enough to continue
          }
        }
      }),
    )

    await waitMs(250)
    await nextFrame()

    return {
      objectCount: document.querySelectorAll('[data-board-object-id]').length,
      imageCount: images.length,
      decodedImageCount: images.filter((element) => element instanceof HTMLImageElement && element.complete).length,
    }
  })

  const measurement = await page.evaluate(async () => {
    const TARGET_FPS = 60
    const FRAME_BUDGET_MS = 1000 / TARGET_FPS
    const PRIME_CYCLES = 1
    const MEASURE_CYCLES = 3
    const STEP_DELTA_Y = 220
    const STEP_INTERVAL_FRAMES = 1
    const SETTLE_FRAMES = 12
    const PAN_SEGMENT_STEPS = 10

    window.__zoomPerfConfig = {
      targetFps: TARGET_FPS,
      frameBudgetMs: FRAME_BUDGET_MS,
      primeCycles: PRIME_CYCLES,
      measureCycles: MEASURE_CYCLES,
      stepDeltaY: STEP_DELTA_Y,
      stepIntervalFrames: STEP_INTERVAL_FRAMES,
      settleFrames: SETTLE_FRAMES,
      panSegmentSteps: PAN_SEGMENT_STEPS,
    }
    return window.__zoomPerfConfig
  })

  const nextAnimationFrame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))

  const startFrameCapture = () => page.evaluate(() => {
    const existingState = window.__zoomPerfState
    if (existingState?.running) {
      throw new Error('Zoom perf capture already running')
    }

    const state = {
      frames: [],
      previousTimestamp: undefined,
      running: true,
      longTaskSupported:
        typeof PerformanceObserver !== 'undefined' &&
        Array.isArray(PerformanceObserver.supportedEntryTypes) &&
        PerformanceObserver.supportedEntryTypes.includes('longtask'),
      longTasks: [],
      longTaskObserver: undefined,
    }
    window.__zoomPerfState = state

    if (state.longTaskSupported) {
      state.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
            attribution: Array.isArray(entry.attribution)
              ? entry.attribution.map((attribution) => ({
                  name: attribution.name,
                  containerType: attribution.containerType,
                  containerName: attribution.containerName,
                  containerSrc: attribution.containerSrc,
                }))
              : [],
          })
        }
      })
      state.longTaskObserver.observe({ type: 'longtask' })
    }

    const tick = (timestamp) => {
      if (state.previousTimestamp !== undefined) {
        state.frames.push(timestamp - state.previousTimestamp)
      }
      state.previousTimestamp = timestamp
      if (state.running) {
        requestAnimationFrame(tick)
      }
    }

    requestAnimationFrame(tick)
  })

  const stopFrameCapture = () => page.evaluate(async () => {
    const state = window.__zoomPerfState
    const config = window.__zoomPerfConfig
    if (!state || !config) {
      throw new Error('Zoom perf capture is not initialized')
    }

    state.running = false
    state.longTaskObserver?.disconnect()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

    const filteredFrames = state.frames.filter((delta) => Number.isFinite(delta) && delta > 0)
    const sortedFrames = [...filteredFrames].sort((a, b) => a - b)
    const totalDurationMs = filteredFrames.reduce((sum, value) => sum + value, 0)
    const averageDeltaMs = filteredFrames.length > 0 ? totalDurationMs / filteredFrames.length : 0
    const averageFps = averageDeltaMs > 0 ? 1000 / averageDeltaMs : 0
    const delayedFrameCount = filteredFrames.filter((delta) => delta > config.frameBudgetMs).length
    const droppedFrameEstimate = filteredFrames.reduce((sum, delta) => (
      sum + Math.max(0, Math.round(delta / config.frameBudgetMs) - 1)
    ), 0)
    const percentile = (fraction) => {
      if (sortedFrames.length === 0) {
        return 0
      }
      const index = Math.min(
        sortedFrames.length - 1,
        Math.max(0, Math.floor((sortedFrames.length - 1) * fraction)),
      )
      return sortedFrames[index]
    }

    const longTaskEntries = state.longTasks
      .filter((entry) => Number.isFinite(entry.duration) && entry.duration >= 50)
      .sort((a, b) => b.duration - a.duration)
    const longTasks = {
      supported: state.longTaskSupported,
      count: longTaskEntries.length,
      totalDurationMs: longTaskEntries.reduce((sum, entry) => sum + entry.duration, 0),
      maxDurationMs: longTaskEntries[0]?.duration ?? 0,
      blockingDurationMs: longTaskEntries.reduce((sum, entry) => sum + Math.max(0, entry.duration - 50), 0),
      topEntries: longTaskEntries.slice(0, 5).map((entry) => ({
        name: entry.name,
        startTimeMs: entry.startTime,
        durationMs: entry.duration,
        attribution: entry.attribution,
      })),
    }

    delete window.__zoomPerfState

    return {
      frameCount: filteredFrames.length,
      totalDurationMs,
      averageDeltaMs,
      averageFps,
      medianDeltaMs: percentile(0.5),
      p95DeltaMs: percentile(0.95),
      worstDeltaMs: sortedFrames[sortedFrames.length - 1] ?? 0,
      delayedFrameCount,
      slowFrameCount: filteredFrames.filter((delta) => delta > config.frameBudgetMs * 1.25).length,
      verySlowFrameCount: filteredFrames.filter((delta) => delta > config.frameBudgetMs * 2).length,
      droppedFrameEstimate,
      longTasks,
    }
  })

  const boardCanvasBox = await page.locator('.board-canvas').boundingBox()
  if (!boardCanvasBox) {
    throw new Error('Missing .board-canvas bounding box')
  }

  const pointerX = boardCanvasBox.x + boardCanvasBox.width * 0.62
  const pointerY = boardCanvasBox.y + boardCanvasBox.height * 0.5

  const pickBackgroundPoint = async (xFraction, yFraction) => {
    const point = await page.evaluate(({ xFraction: xf, yFraction: yf }) => {
      const canvas = document.querySelector('.board-canvas')
      if (!(canvas instanceof HTMLElement)) {
        throw new Error('Missing .board-canvas')
      }

      const rect = canvas.getBoundingClientRect()
      const objectRects = [...document.querySelectorAll('[data-board-object-id]')].map((element) => {
        const objectRect = element.getBoundingClientRect()
        return {
          left: objectRect.left,
          top: objectRect.top,
          right: objectRect.right,
          bottom: objectRect.bottom,
        }
      })

      const isClear = (x, y) => (
        x >= rect.left + 24 &&
        x <= rect.right - 24 &&
        y >= rect.top + 24 &&
        y <= rect.bottom - 24 &&
        objectRects.every((objectRect) => (
          x < objectRect.left ||
          x > objectRect.right ||
          y < objectRect.top ||
          y > objectRect.bottom
        ))
      )

      const preferredX = rect.left + rect.width * xf
      const preferredY = rect.top + rect.height * yf
      if (isClear(preferredX, preferredY)) {
        return { x: preferredX, y: preferredY }
      }

      const stepX = Math.max(36, rect.width / 14)
      const stepY = Math.max(36, rect.height / 10)
      for (let ring = 1; ring <= 6; ring += 1) {
        for (let deltaY = -ring; deltaY <= ring; deltaY += 1) {
          for (let deltaX = -ring; deltaX <= ring; deltaX += 1) {
            const x = preferredX + deltaX * stepX
            const y = preferredY + deltaY * stepY
            if (isClear(x, y)) {
              return { x, y }
            }
          }
        }
      }

      return {
        x: Math.min(rect.right - 32, Math.max(rect.left + 32, preferredX)),
        y: Math.min(rect.bottom - 32, Math.max(rect.top + 32, preferredY)),
      }
    }, { xFraction, yFraction })

    return point
  }

  const readCurrentZoom = () => page.evaluate(() => {
    const boardWorld = document.querySelector('.board-world')
    if (!(boardWorld instanceof HTMLElement)) {
      throw new Error('Missing .board-world')
    }

    const value = Number.parseFloat(getComputedStyle(boardWorld).getPropertyValue('--board-zoom'))
    if (!Number.isFinite(value)) {
      throw new Error('Board zoom is unavailable')
    }

    return value
  })

  const settleFrames = async () => {
    for (let frame = 0; frame < measurement.settleFrames; frame += 1) {
      await nextAnimationFrame()
    }
  }

  const runZoomToLimit = async (deltaY) => {
    await page.mouse.move(pointerX, pointerY)
    let previousZoom = await readCurrentZoom()
    let stalledSteps = 0
    let stepCount = 0

    while (stalledSteps < 4 && stepCount < 80) {
      await page.mouse.wheel(0, deltaY)
      for (let frame = 0; frame < measurement.stepIntervalFrames; frame += 1) {
        await nextAnimationFrame()
      }

      const nextZoom = await readCurrentZoom()
      const changed = Math.abs(nextZoom - previousZoom) > 0.0005
      stalledSteps = changed ? 0 : stalledSteps + 1
      previousZoom = nextZoom
      stepCount += 1
    }

    await settleFrames()
    return previousZoom
  }

  const runPanAtMaxZoom = async () => {
    const anchor = await pickBackgroundPoint(0.22, 0.24)
    const path = [
      { x: anchor.x + 220, y: anchor.y },
      { x: anchor.x + 220, y: anchor.y + 180 },
      { x: anchor.x - 180, y: anchor.y + 180 },
      { x: anchor.x - 180, y: anchor.y - 140 },
      { x: anchor.x + 140, y: anchor.y - 140 },
      { x: anchor.x, y: anchor.y },
    ]

    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.down()
    let current = anchor
    for (const target of path) {
      await page.mouse.move(target.x, target.y, { steps: measurement.panSegmentSteps })
      current = target
      await nextAnimationFrame()
    }
    await page.mouse.up()
    await settleFrames()

    return {
      panStart: anchor,
      panEnd: current,
    }
  }

  const runCycle = async () => {
    const minZoom = await runZoomToLimit(measurement.stepDeltaY)
    const maxZoom = await runZoomToLimit(-measurement.stepDeltaY)
    const panSummary = await runPanAtMaxZoom()
    const settledMinZoom = await runZoomToLimit(measurement.stepDeltaY)
    return {
      minZoom,
      maxZoom,
      ...panSummary,
      settledMinZoom,
    }
  }

  const initialMinZoom = await runZoomToLimit(measurement.stepDeltaY)

  for (let cycle = 0; cycle < measurement.primeCycles; cycle += 1) {
    await runCycle()
  }

  const cycles = []
  for (let cycle = 0; cycle < measurement.measureCycles; cycle += 1) {
    await startFrameCapture()
    const zoomExtremes = await runCycle()
    const summary = await stopFrameCapture()
    cycles.push({
      ...summary,
      ...zoomExtremes,
    })
  }

  const overall = {
    frameCount: cycles.reduce((sum, cycle) => sum + cycle.frameCount, 0),
    totalDurationMs: cycles.reduce((sum, cycle) => sum + cycle.totalDurationMs, 0),
    averageDeltaMs: 0,
    averageFps: 0,
    medianDeltaMs: cycles.length > 0 ? cycles.reduce((sum, cycle) => sum + cycle.medianDeltaMs, 0) / cycles.length : 0,
    p95DeltaMs: cycles.length > 0 ? Math.max(...cycles.map((cycle) => cycle.p95DeltaMs)) : 0,
    worstDeltaMs: cycles.length > 0 ? Math.max(...cycles.map((cycle) => cycle.worstDeltaMs)) : 0,
    delayedFrameCount: cycles.reduce((sum, cycle) => sum + cycle.delayedFrameCount, 0),
    slowFrameCount: cycles.reduce((sum, cycle) => sum + cycle.slowFrameCount, 0),
    verySlowFrameCount: cycles.reduce((sum, cycle) => sum + cycle.verySlowFrameCount, 0),
    droppedFrameEstimate: cycles.reduce((sum, cycle) => sum + cycle.droppedFrameEstimate, 0),
    longTasks: {
      supported: cycles.every((cycle) => cycle.longTasks.supported),
      count: cycles.reduce((sum, cycle) => sum + cycle.longTasks.count, 0),
      totalDurationMs: cycles.reduce((sum, cycle) => sum + cycle.longTasks.totalDurationMs, 0),
      maxDurationMs: cycles.length > 0 ? Math.max(...cycles.map((cycle) => cycle.longTasks.maxDurationMs)) : 0,
      blockingDurationMs: cycles.reduce((sum, cycle) => sum + cycle.longTasks.blockingDurationMs, 0),
      topEntries: cycles
        .flatMap((cycle) => cycle.longTasks.topEntries)
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 5),
    },
  }

  overall.averageDeltaMs = overall.frameCount > 0 ? overall.totalDurationMs / overall.frameCount : 0
  overall.averageFps = overall.averageDeltaMs > 0 ? 1000 / overall.averageDeltaMs : 0

  measurement.cycles = cycles
  measurement.overall = overall
  measurement.initialMinZoom = initialMinZoom

  return {
    roomUrl,
    loadStats,
    measurement,
  }
}

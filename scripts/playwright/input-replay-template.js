async (page) => {
  const recording = __GLASS_RECORDING__
  const config = __GLASS_REPLAY_CONFIG__

  const roomHref = recording?.initialState?.href
  const roomUrl = recording?.roomUrl ?? recording?.initialState?.roomUrl
  const initialCamera = recording?.initialState?.camera
  const initialViewport = recording?.initialState?.viewport
  const canEdit = Boolean(recording?.initialState?.canEdit)
  const objectCountHint = Number(recording?.initialState?.objectCount ?? 0)
  const bootstrapHref = typeof roomHref === 'string' ? roomHref.split('#')[0] : undefined

  if (!roomHref || !roomUrl || !initialCamera) {
    throw new Error('Recording is missing room href, room url, or initial camera')
  }

  if (
    initialViewport &&
    Number.isFinite(initialViewport.width) &&
    Number.isFinite(initialViewport.height) &&
    initialViewport.width > 0 &&
    initialViewport.height > 0
  ) {
    await page.setViewportSize({
      width: Math.round(initialViewport.width),
      height: Math.round(initialViewport.height),
    })
  }

  const inputEvents = recording.events.filter((event) => event.type === 'wheel' || event.type === 'pointer')
  const recordedCameraEvents = recording.events.filter((event) => event.type === 'camera')
  const firstInputTime = inputEvents[0]?.t ?? 0
  const lastInputTime = inputEvents[inputEvents.length - 1]?.t ?? firstInputTime
  const recordedInputDurationMs = Math.max(0, lastInputTime - firstInputTime)
  const recordedMinZoom =
    recordedCameraEvents.length > 0 ? Math.min(...recordedCameraEvents.map((event) => event.camera.zoom)) : initialCamera.zoom
  const recordedMaxZoom =
    recordedCameraEvents.length > 0 ? Math.max(...recordedCameraEvents.map((event) => event.camera.zoom)) : initialCamera.zoom
  const recordedFinalCamera = recordedCameraEvents[recordedCameraEvents.length - 1]?.camera ?? initialCamera
  const recordedSummary = {
    label: recording.label,
    startedAt: recording.startedAt,
    stoppedAt: recording.stoppedAt,
    inputEventCount: inputEvents.length,
    wheelEventCount: inputEvents.filter((event) => event.type === 'wheel').length,
    pointerEventCount: inputEvents.filter((event) => event.type === 'pointer').length,
    recordedInputDurationMs,
    recordedMinZoom,
    recordedMaxZoom,
    initialCamera,
    recordedFinalCamera,
  }
  const fullTraceCategories = [
    '-*',
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'blink.user_timing',
    'cc',
    'input',
    'latencyInfo',
    'loading',
    'toplevel',
    'v8.execute',
  ].join(',')
  const frameTraceCategories = [
    '-*',
    'cc',
    'disabled-by-default-devtools.timeline.frame',
  ].join(',')

  const nextAnimationFrame = () =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))

  const waitForBoardReady = async () => {
    return page.evaluate(async ({ objectCountHint: hint }) => {
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      const waitMs = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
      const minExpectedObjects = Math.max(20, Math.min(40, Math.floor(hint * 0.2) || 20))
      const minExpectedSurfaces = 20
      const maxWaitMs = 30000

      await waitMs(250)
      await nextFrame()

      await new Promise((resolve, reject) => {
        let elapsed = 0
        const poll = () => {
          if (document.querySelectorAll('[data-board-object-id]').length >= minExpectedObjects) {
            resolve(undefined)
            return
          }

          elapsed += 50
          if (elapsed >= 15000) {
            reject(new Error(`Board objects did not load in time (expected ${minExpectedObjects})`))
            return
          }
          window.setTimeout(poll, 50)
        }
        poll()
      })

      let stableImageCount = 0
      let previousSurfaceCount = -1
      let elapsed = 0
      while (elapsed < maxWaitMs && stableImageCount < 8) {
        const surfaces = [...document.querySelectorAll('[data-board-sprite-stage]')]
        const surfaceCount = surfaces.length
        const preparingCount = surfaces.filter((element) => (
          element instanceof HTMLElement &&
          element.dataset.boardSpriteStage === 'preparing'
        )).length
        const incompleteCount = surfaces.filter((element) => (
          !(element instanceof HTMLImageElement) ||
          element.dataset.boardSpriteStage !== 'ready' ||
          !element.complete ||
          element.naturalWidth <= 0 ||
          element.naturalHeight <= 0
        )).length
        const failedCount = surfaces.filter((element) => (
          !(element instanceof HTMLImageElement) ||
          element.dataset.boardSpriteStage === 'failed'
        )).length

        if (
          surfaceCount >= minExpectedSurfaces &&
          preparingCount === 0 &&
          incompleteCount + failedCount === 0 &&
          surfaceCount === previousSurfaceCount
        ) {
          stableImageCount += 1
        } else {
          stableImageCount = 0
          previousSurfaceCount = surfaceCount
        }

        await waitMs(100)
        await nextFrame()
        elapsed += 100
      }

      const images = [...document.querySelectorAll('.board-sprite-image[data-board-sprite-stage="ready"]')]
      const surfaces = [...document.querySelectorAll('[data-board-sprite-stage]')]
      if (surfaces.length < minExpectedSurfaces) {
        throw new Error(
          `Expected at least ${minExpectedSurfaces} sprite surfaces before replay, found ${surfaces.length}. ` +
            'This usually means the room is not available in the current browser profile.',
        )
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
        imageCount: surfaces.length,
        decodedImageCount: images.filter((element) => element instanceof HTMLImageElement && element.complete).length,
        preparedImageCount: images.length,
      }
    }, { objectCountHint })
  }

  const loadRoomAtRecordedState = async () => {
    if (!bootstrapHref) {
      throw new Error('Recording is missing a bootstrap href')
    }

    await page.goto(bootstrapHref, { waitUntil: 'domcontentloaded' })
    await page.evaluate(
      ({ nextRoomUrl, nextCamera, nextCanEdit }) => {
        window.localStorage.setItem(`glass.camera.${nextRoomUrl}`, JSON.stringify(nextCamera))
        if (!nextCanEdit) {
          window.localStorage.removeItem(`glass.player.${nextRoomUrl}`)
        }
      },
      {
        nextRoomUrl: roomUrl,
        nextCamera: initialCamera,
        nextCanEdit: canEdit,
      },
    )

    await page.goto(roomHref, { waitUntil: 'domcontentloaded' })
    return waitForBoardReady()
  }

  const installPerfConfig = () =>
    page.evaluate(({ targetFps }) => {
      window.__zoomPerfConfig = {
        targetFps,
        frameBudgetMs: 1000 / targetFps,
      }
    }, { targetFps: 60 })

  const startFrameCapture = () =>
    page.evaluate(() => {
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

  const stopFrameCapture = () =>
    page.evaluate(async () => {
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

  const buttonNameFor = (button) => {
    if (button === 1) {
      return 'middle'
    }
    if (button === 2) {
      return 'right'
    }
    return 'left'
  }

  const readSavedCamera = async () => {
    return page.evaluate((nextRoomUrl) => {
      const raw = window.localStorage.getItem(`glass.camera.${nextRoomUrl}`)
      if (!raw) {
        return undefined
      }

      try {
        return JSON.parse(raw)
      } catch {
        return undefined
      }
    }, roomUrl)
  }

  const summarizeFrameTrace = (tracePayload) => {
    if (!tracePayload) {
      return {
        supported: false,
        traceEventCount: 0,
        beginFrameCount: 0,
        drawFrameCount: 0,
        droppedFrameCount: 0,
        partialDroppedFrameCount: 0,
        mainFrameAbortedCount: 0,
        didNotSubmitCount: 0,
        dropRate: 0,
        partialDropRate: 0,
      }
    }

    let traceRoot
    try {
      traceRoot = JSON.parse(tracePayload)
    } catch (error) {
      return {
        supported: false,
        parseError: error instanceof Error ? error.message : String(error),
        traceEventCount: 0,
        beginFrameCount: 0,
        drawFrameCount: 0,
        droppedFrameCount: 0,
        partialDroppedFrameCount: 0,
        mainFrameAbortedCount: 0,
        didNotSubmitCount: 0,
        dropRate: 0,
        partialDropRate: 0,
      }
    }

    const traceEvents = Array.isArray(traceRoot?.traceEvents)
      ? traceRoot.traceEvents
      : Array.isArray(traceRoot)
        ? traceRoot
        : []
    const beginFrames = new Set()
    const drawFrames = new Set()
    const droppedFrames = new Set()
    const partialDroppedFrames = new Set()
    const mainFrameAborted = new Set()
    const didNotSubmit = new Set()

    for (const event of traceEvents) {
      const frameSeqId = event?.args?.frameSeqId
      if (!Number.isFinite(frameSeqId)) {
        continue
      }

      if (event.name === 'BeginFrame') {
        beginFrames.add(frameSeqId)
      } else if (event.name === 'DrawFrame') {
        drawFrames.add(frameSeqId)
      } else if (event.name === 'DroppedFrame') {
        droppedFrames.add(frameSeqId)
        if (event?.args?.hasPartialUpdate) {
          partialDroppedFrames.add(frameSeqId)
        }
      } else if (event.name === 'MainFrameAborted') {
        mainFrameAborted.add(frameSeqId)
      } else if (event.name === 'DidNotSubmitInLastFrame') {
        didNotSubmit.add(frameSeqId)
      }
    }

    return {
      supported: true,
      traceEventCount: traceEvents.length,
      beginFrameCount: beginFrames.size,
      drawFrameCount: drawFrames.size,
      droppedFrameCount: droppedFrames.size,
      partialDroppedFrameCount: partialDroppedFrames.size,
      mainFrameAbortedCount: mainFrameAborted.size,
      didNotSubmitCount: didNotSubmit.size,
      dropRate: beginFrames.size > 0 ? droppedFrames.size / beginFrames.size : 0,
      partialDropRate: beginFrames.size > 0 ? partialDroppedFrames.size / beginFrames.size : 0,
    }
  }

  const captureBrowserTrace = async (runReplay, runLabel, options = {}) => {
    const { categories = fullTraceCategories, downloadTrace = false } = options
    const client = await page.context().newCDPSession(page)
    const tracingComplete = new Promise((resolve) => {
      client.on('Tracing.tracingComplete', resolve)
    })

    await client.send('Tracing.start', {
      categories,
      options: 'sampling-frequency=8000',
      transferMode: 'ReturnAsStream',
    })

    const replaySummary = await runReplay()
    await client.send('Tracing.end')
    const tracingResult = await tracingComplete

    let tracePayload = ''
    const streamHandle = tracingResult?.stream
    if (streamHandle) {
      while (true) {
        const chunk = await client.send('IO.read', { handle: streamHandle })
        tracePayload += chunk.base64Encoded ? atob(chunk.data) : chunk.data
        if (chunk.eof) {
          break
        }
      }
      await client.send('IO.close', { handle: streamHandle }).catch(() => {})
    }

    let suggestedFilename
    let downloadPath
    if (downloadTrace) {
      suggestedFilename = `glass-replay-trace-${runLabel}-${Date.now()}.json`
      const downloadPromise = page.waitForEvent('download')
      await page.evaluate(({ payload, filename }) => {
        const blob = new Blob([payload], { type: 'application/json' })
        const objectUrl = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = filename
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      }, { payload: tracePayload, filename: suggestedFilename })

      const download = await downloadPromise
      downloadPath = await download.path().catch(() => undefined)
    }

    return {
      replaySummary,
      trace: {
        categories,
        summary: summarizeFrameTrace(tracePayload),
        suggestedFilename,
        downloadPath,
        bytes: tracePayload.length,
      },
    }
  }

  const replayInputSequence = async () => {
    let previousTime = firstInputTime
    const wallStart = Date.now()

    for (const event of inputEvents) {
      const waitMs = Math.max(0, event.t - previousTime)
      if (waitMs > 0) {
        await page.waitForTimeout(waitMs)
      }

      if (event.type === 'pointer') {
        if (event.pointerType && event.pointerType !== 'mouse') {
          previousTime = event.t
          continue
        }

        await page.mouse.move(event.clientX, event.clientY)
        if (event.phase === 'down') {
          await page.mouse.down({ button: buttonNameFor(event.button) })
        } else if (event.phase === 'up') {
          await page.mouse.up({ button: buttonNameFor(event.button) })
        }
      } else if (event.type === 'wheel') {
        await page.mouse.move(event.clientX, event.clientY)
        await page.mouse.wheel(event.deltaX ?? 0, event.deltaY ?? 0)
      }

      previousTime = event.t
    }

    for (let frame = 0; frame < 18; frame += 1) {
      await nextAnimationFrame()
    }
    await page.waitForTimeout(250)

    const replayWallDurationMs = Date.now() - wallStart
    const savedCamera = await readSavedCamera()
    return {
      replayWallDurationMs,
      savedCamera,
    }
  }

  const allRuns = []
  const totalRuns = config.primeRuns + config.measureRuns
  let firstTraceArtifact

  for (let index = 0; index < totalRuns; index += 1) {
    const phase = index < config.primeRuns ? 'prime' : 'measure'
    const loadStats = await loadRoomAtRecordedState()
    await installPerfConfig()

    if (phase === 'measure') {
      await startFrameCapture()
    }

    let replaySummary
    let traceArtifact
    if (phase === 'measure' && (config.captureFrameTrace || config.captureTrace)) {
      const traceRun = await captureBrowserTrace(
        replayInputSequence,
        `run-${index - config.primeRuns + 1}`,
        {
          categories: config.captureTrace ? fullTraceCategories : frameTraceCategories,
          downloadTrace: config.captureTrace && !firstTraceArtifact,
        },
      )
      replaySummary = traceRun.replaySummary
      traceArtifact = traceRun.trace
      if (!firstTraceArtifact && traceArtifact.downloadPath) {
        firstTraceArtifact = traceArtifact
      }
    } else {
      replaySummary = await replayInputSequence()
    }
    let metrics = undefined
    if (phase === 'measure') {
      metrics = await stopFrameCapture()
    }

    allRuns.push({
      phase,
      index: phase === 'prime' ? index + 1 : index - config.primeRuns + 1,
      loadStats,
      replay: replaySummary,
      trace: traceArtifact,
      compositor: traceArtifact?.summary,
      metrics,
    })
  }

  const measureRuns = allRuns.filter((run) => run.phase === 'measure')
  const overall = {
    frameCount: measureRuns.reduce((sum, run) => sum + (run.metrics?.frameCount ?? 0), 0),
    totalDurationMs: measureRuns.reduce((sum, run) => sum + (run.metrics?.totalDurationMs ?? 0), 0),
    averageDeltaMs: 0,
    averageFps: 0,
    medianDeltaMs:
      measureRuns.length > 0
        ? measureRuns.reduce((sum, run) => sum + (run.metrics?.medianDeltaMs ?? 0), 0) / measureRuns.length
        : 0,
    p95DeltaMs: measureRuns.length > 0 ? Math.max(...measureRuns.map((run) => run.metrics?.p95DeltaMs ?? 0)) : 0,
    worstDeltaMs: measureRuns.length > 0 ? Math.max(...measureRuns.map((run) => run.metrics?.worstDeltaMs ?? 0)) : 0,
    delayedFrameCount: measureRuns.reduce((sum, run) => sum + (run.metrics?.delayedFrameCount ?? 0), 0),
    slowFrameCount: measureRuns.reduce((sum, run) => sum + (run.metrics?.slowFrameCount ?? 0), 0),
    verySlowFrameCount: measureRuns.reduce((sum, run) => sum + (run.metrics?.verySlowFrameCount ?? 0), 0),
    droppedFrameEstimate: measureRuns.reduce((sum, run) => sum + (run.metrics?.droppedFrameEstimate ?? 0), 0),
    longTasks: {
      supported: measureRuns.every((run) => run.metrics?.longTasks?.supported ?? false),
      count: measureRuns.reduce((sum, run) => sum + (run.metrics?.longTasks?.count ?? 0), 0),
      totalDurationMs: measureRuns.reduce((sum, run) => sum + (run.metrics?.longTasks?.totalDurationMs ?? 0), 0),
      maxDurationMs:
        measureRuns.length > 0 ? Math.max(...measureRuns.map((run) => run.metrics?.longTasks?.maxDurationMs ?? 0)) : 0,
      blockingDurationMs: measureRuns.reduce(
        (sum, run) => sum + (run.metrics?.longTasks?.blockingDurationMs ?? 0),
        0,
      ),
      topEntries: measureRuns
        .flatMap((run) => run.metrics?.longTasks?.topEntries ?? [])
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, 5),
    },
    compositor: {
      supported: measureRuns.some((run) => Boolean(run.compositor?.supported)),
      traceEventCount: measureRuns.reduce((sum, run) => sum + (run.compositor?.traceEventCount ?? 0), 0),
      beginFrameCount: measureRuns.reduce((sum, run) => sum + (run.compositor?.beginFrameCount ?? 0), 0),
      drawFrameCount: measureRuns.reduce((sum, run) => sum + (run.compositor?.drawFrameCount ?? 0), 0),
      droppedFrameCount: measureRuns.reduce((sum, run) => sum + (run.compositor?.droppedFrameCount ?? 0), 0),
      partialDroppedFrameCount: measureRuns.reduce(
        (sum, run) => sum + (run.compositor?.partialDroppedFrameCount ?? 0),
        0,
      ),
      mainFrameAbortedCount: measureRuns.reduce((sum, run) => sum + (run.compositor?.mainFrameAbortedCount ?? 0), 0),
      didNotSubmitCount: measureRuns.reduce((sum, run) => sum + (run.compositor?.didNotSubmitCount ?? 0), 0),
      dropRate: 0,
      partialDropRate: 0,
    },
  }

  overall.averageDeltaMs = overall.frameCount > 0 ? overall.totalDurationMs / overall.frameCount : 0
  overall.averageFps = overall.averageDeltaMs > 0 ? 1000 / overall.averageDeltaMs : 0
  overall.compositor.dropRate =
    overall.compositor.beginFrameCount > 0
      ? overall.compositor.droppedFrameCount / overall.compositor.beginFrameCount
      : 0
  overall.compositor.partialDropRate =
    overall.compositor.beginFrameCount > 0
      ? overall.compositor.partialDroppedFrameCount / overall.compositor.beginFrameCount
      : 0

  return {
    roomHref,
    config,
    recordedSummary,
    runs: allRuns,
    trace: firstTraceArtifact,
    overall,
  }
}

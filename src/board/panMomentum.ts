export interface PanMomentumPoint {
  x: number
  y: number
}

export interface PanVelocitySample {
  point: PanMomentumPoint
  time: number
}

function trimPanVelocitySamples(
  samples: readonly PanVelocitySample[],
  now: number,
  sampleWindowSeconds: number,
) {
  return samples.filter((sample) => now - sample.time <= sampleWindowSeconds)
}

function velocityFromSamples(samples: readonly PanVelocitySample[]): PanMomentumPoint {
  const firstSample = samples[0]
  const lastSample = samples[samples.length - 1]
  if (!firstSample || !lastSample) {
    return { x: 0, y: 0 }
  }

  const dt = lastSample.time - firstSample.time
  if (dt <= 0) {
    return { x: 0, y: 0 }
  }

  return {
    x: (lastSample.point.x - firstSample.point.x) / dt,
    y: (lastSample.point.y - firstSample.point.y) / dt,
  }
}

export function releasePanVelocity(
  samples: readonly PanVelocitySample[],
  releasePoint: PanMomentumPoint,
  releaseTime: number,
  sampleWindowSeconds: number,
) {
  const releaseSamples = trimPanVelocitySamples(
    [...samples, { point: releasePoint, time: releaseTime }],
    releaseTime,
    sampleWindowSeconds,
  )
  return velocityFromSamples(releaseSamples)
}

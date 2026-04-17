import type { CameraState, Id } from '../model/types'

interface Size {
  width: number
  height: number
}

export interface RecorderContextSnapshot {
  roomUrl: string
  href: string
  hash: string
  camera: CameraState
  viewport: Size
  selectedId?: Id
  selectedIds: Id[]
  canEdit: boolean
  objectCount: number
}

interface RecorderBinding {
  host: HTMLElement
  root: HTMLElement
  getContext: () => RecorderContextSnapshot
}

interface RecorderEventBase {
  type: string
  t: number
}

interface WheelRecorderEvent extends RecorderEventBase {
  type: 'wheel'
  clientX: number
  clientY: number
  localX?: number
  localY?: number
  deltaX: number
  deltaY: number
  deltaZ: number
  deltaMode: number
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  targetObjectId?: Id
}

interface PointerRecorderEvent extends RecorderEventBase {
  type: 'pointer'
  phase: 'down' | 'move' | 'up' | 'cancel'
  pointerId: number
  pointerType: string
  isPrimary: boolean
  button: number
  buttons: number
  clientX: number
  clientY: number
  localX?: number
  localY?: number
  pressure: number
  tiltX: number
  tiltY: number
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  targetObjectId?: Id
}

interface CameraRecorderEvent extends RecorderEventBase {
  type: 'camera'
  camera: CameraState
}

interface SelectionRecorderEvent extends RecorderEventBase {
  type: 'selection'
  selectedId?: Id
  selectedIds: Id[]
}

interface ViewportRecorderEvent extends RecorderEventBase {
  type: 'viewport'
  viewport: Size
}

type RecorderEvent =
  | WheelRecorderEvent
  | PointerRecorderEvent
  | CameraRecorderEvent
  | SelectionRecorderEvent
  | ViewportRecorderEvent

interface InputRecordingSession {
  version: 1
  startedAt: string
  stoppedAt?: string
  label?: string
  roomUrl: string
  href: string
  hash: string
  userAgent: string
  devicePixelRatio: number
  initialState: RecorderContextSnapshot
  events: RecorderEvent[]
}

export interface BoardInputRecorderApi {
  start: (label?: string) => InputRecordingSession | undefined
  stop: () => InputRecordingSession | undefined
  clear: () => void
  export: () => InputRecordingSession | undefined
  copy: () => Promise<boolean>
  download: (filename?: string) => boolean
  isRecording: () => boolean
  setAutoStart: (enabled: boolean) => void
}

declare global {
  interface Window {
    __glassInputRecorder?: BoardInputRecorderApi
    __glassInputRecorderImpl?: BoardInputRecorder
  }
}

const AUTO_START_STORAGE_KEY = 'glass.inputRecorder.autoStart'

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function timeSince(startedAtMs: number) {
  return Number((performance.now() - startedAtMs).toFixed(3))
}

function clientToLocal(root: HTMLElement, clientX: number, clientY: number) {
  const rect = root.getBoundingClientRect()
  return {
    x: Number((clientX - rect.left).toFixed(3)),
    y: Number((clientY - rect.top).toFixed(3)),
  }
}

function objectIdAtPointFromTarget(target: EventTarget | null, clientX: number, clientY: number) {
  const targetElement = target instanceof Element ? target : undefined
  const candidate =
    targetElement?.closest<HTMLElement>('[data-board-object-id]') ??
    document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-board-object-id]')
  return candidate?.dataset.boardObjectId
}

class BoardInputRecorder {
  private binding?: RecorderBinding
  private session?: InputRecordingSession
  private capturing = false
  private sessionStartedAtMs = 0
  private installedHost?: HTMLElement
  private boundWheelListener = (event: WheelEvent) => {
    if (!this.capturing || !this.session || !this.binding) {
      return
    }

    const local = clientToLocal(this.binding.root, event.clientX, event.clientY)
    this.session.events.push({
      type: 'wheel',
      t: timeSince(this.sessionStartedAtMs),
      clientX: Number(event.clientX.toFixed(3)),
      clientY: Number(event.clientY.toFixed(3)),
      localX: local.x,
      localY: local.y,
      deltaX: Number(event.deltaX.toFixed(3)),
      deltaY: Number(event.deltaY.toFixed(3)),
      deltaZ: Number(event.deltaZ.toFixed(3)),
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      targetObjectId: objectIdAtPointFromTarget(event.target, event.clientX, event.clientY),
    })
  }

  private readonly pointerHandler = (phase: PointerRecorderEvent['phase']) => (event: PointerEvent) => {
    if (!this.capturing || !this.session || !this.binding) {
      return
    }

    const local = clientToLocal(this.binding.root, event.clientX, event.clientY)
    this.session.events.push({
      type: 'pointer',
      phase,
      t: timeSince(this.sessionStartedAtMs),
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      button: event.button,
      buttons: event.buttons,
      clientX: Number(event.clientX.toFixed(3)),
      clientY: Number(event.clientY.toFixed(3)),
      localX: local.x,
      localY: local.y,
      pressure: Number(event.pressure.toFixed(4)),
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      targetObjectId: objectIdAtPointFromTarget(event.target, event.clientX, event.clientY),
    })
  }

  private readonly boundPointerDownListener = this.pointerHandler('down')
  private readonly boundPointerMoveListener = this.pointerHandler('move')
  private readonly boundPointerUpListener = this.pointerHandler('up')
  private readonly boundPointerCancelListener = this.pointerHandler('cancel')

  bind(binding: RecorderBinding) {
    this.unbind()
    this.binding = binding
    this.installedHost = binding.host
    binding.host.addEventListener('wheel', this.boundWheelListener, { capture: true })
    binding.host.addEventListener('pointerdown', this.boundPointerDownListener, { capture: true })
    window.addEventListener('pointermove', this.boundPointerMoveListener, { capture: true })
    window.addEventListener('pointerup', this.boundPointerUpListener, { capture: true })
    window.addEventListener('pointercancel', this.boundPointerCancelListener, { capture: true })

    if (this.shouldAutoStart() && !this.session) {
      this.start('auto')
    }
  }

  unbind() {
    const host = this.installedHost
    if (host) {
      host.removeEventListener('wheel', this.boundWheelListener, { capture: true })
      host.removeEventListener('pointerdown', this.boundPointerDownListener, { capture: true })
    }
    window.removeEventListener('pointermove', this.boundPointerMoveListener, { capture: true })
    window.removeEventListener('pointerup', this.boundPointerUpListener, { capture: true })
    window.removeEventListener('pointercancel', this.boundPointerCancelListener, { capture: true })
    this.installedHost = undefined
    this.binding = undefined
  }

  start(label?: string) {
    if (!this.binding) {
      return undefined
    }

    const context = cloneJson(this.binding.getContext())
    this.sessionStartedAtMs = performance.now()
    this.capturing = true
    this.session = {
      version: 1,
      startedAt: new Date().toISOString(),
      label: label?.trim() || undefined,
      roomUrl: context.roomUrl,
      href: context.href,
      hash: context.hash,
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio || 1,
      initialState: context,
      events: [],
    }
    return this.export()
  }

  stop() {
    if (!this.session) {
      return undefined
    }

    this.session.stoppedAt = new Date().toISOString()
    this.capturing = false
    return this.export()
  }

  clear() {
    this.capturing = false
    this.session = undefined
    this.sessionStartedAtMs = 0
  }

  export() {
    return this.session ? cloneJson(this.session) : undefined
  }

  async copy() {
    const recording = this.export()
    if (!recording || !navigator.clipboard?.writeText) {
      return false
    }

    await navigator.clipboard.writeText(JSON.stringify(recording, null, 2))
    return true
  }

  download(filename = `glass-input-recording-${Date.now()}.json`) {
    const recording = this.export()
    if (!recording) {
      return false
    }

    const blob = new Blob([JSON.stringify(recording, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    return true
  }

  isRecording() {
    return this.capturing
  }

  setAutoStart(enabled: boolean) {
    if (enabled) {
      window.localStorage.setItem(AUTO_START_STORAGE_KEY, '1')
    } else {
      window.localStorage.removeItem(AUTO_START_STORAGE_KEY)
    }
  }

  recordCamera(camera: CameraState) {
    if (!this.capturing || !this.session) {
      return
    }

    this.session.events.push({
      type: 'camera',
      t: timeSince(this.sessionStartedAtMs),
      camera: cloneJson(camera),
    })
  }

  recordSelection(selectedId: Id | undefined, selectedIds: Id[]) {
    if (!this.capturing || !this.session) {
      return
    }

    this.session.events.push({
      type: 'selection',
      t: timeSince(this.sessionStartedAtMs),
      selectedId,
      selectedIds: [...selectedIds],
    })
  }

  recordViewport(viewport: Size) {
    if (!this.capturing || !this.session) {
      return
    }

    this.session.events.push({
      type: 'viewport',
      t: timeSince(this.sessionStartedAtMs),
      viewport: cloneJson(viewport),
    })
  }

  private shouldAutoStart() {
    const params = new URLSearchParams(window.location.search)
    if (params.get('glass-record-input') === '1') {
      return true
    }
    return window.localStorage.getItem(AUTO_START_STORAGE_KEY) === '1'
  }
}

function getRecorder() {
  if (!window.__glassInputRecorderImpl) {
    window.__glassInputRecorderImpl = new BoardInputRecorder()
  }
  return window.__glassInputRecorderImpl
}

export function bindBoardInputRecorder(binding: RecorderBinding) {
  const recorder = getRecorder()
  recorder.bind(binding)

  window.__glassInputRecorder = {
    start: (label?: string) => recorder.start(label),
    stop: () => recorder.stop(),
    clear: () => recorder.clear(),
    export: () => recorder.export(),
    copy: () => recorder.copy(),
    download: (filename?: string) => recorder.download(filename),
    isRecording: () => recorder.isRecording(),
    setAutoStart: (enabled: boolean) => recorder.setAutoStart(enabled),
  }

  return () => {
    recorder.unbind()
  }
}

export function recordBoardInputRecorderCamera(camera: CameraState) {
  getRecorder().recordCamera(camera)
}

export function recordBoardInputRecorderSelection(selectedId: Id | undefined, selectedIds: Id[]) {
  getRecorder().recordSelection(selectedId, selectedIds)
}

export function recordBoardInputRecorderViewport(viewport: Size) {
  getRecorder().recordViewport(viewport)
}

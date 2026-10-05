import assert from 'node:assert/strict'
import { ControlBus } from '../src/engine/controlBus'
import type { CommandResult, DjCommand } from '@ncsound/station-core/contract'
import type { SocketLike } from '../src/engine/controlLink'

console.log('=== Testing ControlBus (policy layer over ControlLink) ===')

/** Records every frame so a test can assert what would have reached ingest. */
class FakeSocket implements SocketLike {
  readyState = 0
  frames: { id: string; command: DjCommand }[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null

  send(data: string): void {
    const frame = JSON.parse(data) as { id: string; command: DjCommand }
    this.frames.push(frame)
  }
  close(): void {
    this.readyState = 3
  }
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  /** Answer the nth pending frame with `ok`, echoing its id. */
  answer(index: number, ok = true): void {
    const frame = this.frames[index]
    const result: CommandResult = ok
      ? { id: frame.id, ok: true, appliedAt: new Date().toISOString() }
      : { id: frame.id, ok: false, appliedAt: new Date().toISOString(), code: 'INVALID_PARAMS', error: 'nope' }
    this.onmessage?.({ data: JSON.stringify({ type: 'command.result', at: new Date().toISOString(), result }) })
  }
  commands(): DjCommand[] {
    return this.frames.map((f) => f.command)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeBus() {
  const sockets: FakeSocket[] = []
  const bus = new ControlBus({
    socketFactory: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    commandTimeoutMs: 200,
    connectTimeoutMs: 500,
  })
  return { bus, sockets }
}

async function connected() {
  const { bus, sockets } = makeBus()
  const refusals: string[] = []
  bus.onRefusal = (message) => refusals.push(message)
  bus.start()
  sockets[0].open()
  sockets[0].onmessage?.({
    data: JSON.stringify({
      type: 'connection.ready',
      at: new Date().toISOString(),
      actor: { id: 'console', role: 'console', label: 'dj console' },
    }),
  })
  await sleep(5)
  return { bus, sockets, refusals }
}

// 1. Per-slot commands must not share a coalescing slot.
//
//    `cue.seek` used to key on its type alone, so a jog on deck A followed by a
//    jog on deck B collapsed into one pending value and only one deck moved.
//    The operator saw one wheel respond and the other ignore them.
{
  const { bus, sockets, refusals } = await connected()
  const socket = sockets[0]

  // A jog on deck A occupies the only in-flight slot for its key.
  bus.sendCoalesced({ type: 'cue.seek', slot: 0, seconds: 10 })
  await sleep(2)
  bus.sendCoalesced({ type: 'cue.seek', slot: 1, seconds: 30 })
  await sleep(2)

  const sent = socket.commands()
  const slotsSent = sent.filter((c) => c.type === 'cue.seek').map((c) => (c as { slot: number }).slot)
  assert.deepEqual(slotsSent.sort(), [0, 1], `both decks must be sent independently, got ${JSON.stringify(slotsSent)}`)
  assert.equal(refusals.length, 0, 'no refusals while connected')
  bus.stop()
}

// 2. A continuous control sends immediately, then only the newest value waits.
{
  const { bus, sockets } = await connected()
  const socket = sockets[0]

  bus.sendCoalesced({ type: 'mix.setCrossfader', position: -1 })
  await sleep(2)
  // Socket busy: two more values arrive before the first is answered.
  bus.sendCoalesced({ type: 'mix.setCrossfader', position: 0 })
  bus.sendCoalesced({ type: 'mix.setCrossfader', position: 0.5 })
  await sleep(2)
  assert.equal(socket.commands().length, 1, 'only the first value goes out while one is in flight')

  socket.answer(0)
  await sleep(5)
  const positions = socket
    .commands()
    .filter((c): c is Extract<DjCommand, { type: 'mix.setCrossfader' }> => c.type === 'mix.setCrossfader')
    .map((c) => c.position)
  assert.equal(positions.length, 2, 'the coalesced tail is sent once the socket frees up')
  assert.equal(positions[1], 0.5, 'the newest value wins, not the middle one')
  bus.stop()
}

// 3. Mode is engine state, not a local boolean.
{
  const { bus, sockets } = await connected()
  // The socket handshake alone proves the engine answers, so this is already
  // `engine` — not `rehearsal`. What is not yet known is whether the stream is
  // up, and that must not be reported as ON AIR.
  assert.equal(bus.mode().kind, 'engine', 'a completed handshake means the engine answers')
  assert.equal(bus.mode().drivesEngine, true)

  // The engine's verdict decides ON AIR, not the local view.
  //
  // This used to be `observeStation({ onAir: true })` — the Icecast mount. But
  // the mount stays connected while Liquidsoap outputs silence, so the site and
  // the console reached opposite conclusions about the same station. The mode
  // is now read from `observeBroadcast`, which carries the engine's single
  // answer.
  const verdict = (onAir: boolean, reason = '') => ({
    onAir,
    reason,
    components: { enginePlaying: true, outputLive: onAir, mountConnected: true },
  })

  // Connected, not broadcasting: controls still reach the engine.
  bus.observeStation({ reachable: true, onAir: false })
  bus.observeBroadcast(verdict(false, 'engine has no audio armed'))
  assert.equal(bus.mode().kind, 'engine')
  assert.equal(bus.mode().drivesEngine, true)
  // The engine's reason is what the operator reads, so it must survive.
  assert.match(bus.mode().detail, /no audio armed/)

  // Broadcasting: ON AIR.
  bus.observeStation({ reachable: true, onAir: true })
  bus.observeBroadcast(verdict(true))
  assert.equal(bus.mode().kind, 'on-air')
  assert.equal(bus.mode().drivesEngine, true)

  // A socket push saying the mount is up must NOT override the engine's
  // verdict. This is the exact divergence that had the site claiming "live"
  // while the station was silent.
  bus.observeStation({ reachable: true, onAir: true })
  bus.observeBroadcast(verdict(false, 'output switched off air by the operator'))
  assert.equal(bus.mode().kind, 'engine', 'a connected mount is not proof of a broadcast')
  assert.match(bus.mode().detail, /switched off air/)

  // Engine gone: REHEARSAL, and controls stop reaching the engine.
  bus.observeStation({ reachable: false, onAir: null })
  assert.equal(bus.mode().kind, 'rehearsal')
  assert.equal(bus.mode().drivesEngine, false, 'rehearsal must not claim to drive the engine')
  bus.stop()
}

// 4. Offline refusal from a coalesced control is silent; a discrete one is not.
//
//    The mode badge already says REHEARSAL persistently. A toast on every
//    pointermove during a fader drag says the same thing once a second and
//    buries everything else.
{
  const { bus, sockets } = makeBus()
  const refusals: string[] = []
  bus.onRefusal = (message) => refusals.push(message)
  // Never start the bus, so nothing is reachable and every send falls to HTTP.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('connection refused')
  }) as typeof fetch

  for (let i = 0; i < 5; i++) {
    bus.sendCoalesced({ type: 'mix.setCrossfader', position: i / 10 })
    await sleep(3)
  }
  assert.equal(refusals.length, 0, `coalesced offline sends must stay quiet, got ${JSON.stringify(refusals)}`)

  // A button press is discrete and must still report.
  await bus.send({ type: 'transport.stop' })
  assert.equal(refusals.length, 1, 'a discrete offline command reports exactly once')
  assert.match(refusals[0], /Engine unreachable/)

  globalThis.fetch = originalFetch
  bus.stop()
}

// 5. A refusal names the command and the reason.
{
  const { bus, sockets, refusals } = await connected()
  const pending = bus.send({ type: 'mix.setMasterGain', gain: -20 })
  await sleep(2)
  sockets[0].answer(0, false)
  await pending
  assert.equal(refusals.length, 1)
  assert.match(refusals[0], /mix\.setMasterGain refused/)
  assert.match(refusals[0], /nope/)
  bus.stop()
}

// 6. A mode listener fires on change, not on every poll.
{
  const { bus } = await connected()
  const seen: string[] = []
  bus.onModeChange((m) => seen.push(m.kind))

  const verdict = (onAir: boolean) => ({
    onAir,
    reason: '',
    components: { enginePlaying: true, outputLive: onAir, mountConnected: true },
  })

  bus.observeStation({ reachable: true, onAir: false })
  bus.observeBroadcast(verdict(true))
  await sleep(2)
  // Three identical polls must not re-notify.
  for (let i = 0; i < 3; i++) {
    bus.observeBroadcast(verdict(true))
    await sleep(2)
  }
  bus.observeBroadcast(verdict(false))
  await sleep(2)

  assert.deepEqual(seen, ['on-air', 'engine'], `repeated identical observations must not re-notify, got ${JSON.stringify(seen)}`)
  bus.stop()
}

console.log('All controlBus tests passed successfully!')

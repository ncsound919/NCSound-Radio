# scratch-agent-ts

TypeScript port of the Scratch Agent plan (M1 renderer, M3 composer + rules director, M4 critic, M5 LLM director client) plus a React panel. Zero runtime dependencies besides React.

Drop `src/` into your app, then:

```tsx
import { ScratchPanel } from "./scratch-agent";
<ScratchPanel buffer={deckBuffer} audioContext={ctx} defaultBpm={92} onRendered={(buf) => routeToMixer(buf)} />
```

Headless:

```ts
const bank = buildSliceBank(monoSamples, sr);
const grid = gridFromBpm(92, firstBeatSeconds, durationSeconds);
const run = await runScratchAgent({ src: monoSamples, fs: sr, bank, grid, bars: 2, style: "medium", seed: 1, phraseStartBeat: 0 });
```

## What is and isn't covered
- Schema field names stay snake_case so JSON round-trips with the Python pipeline.
- Analysis (M2) is a browser stand-in: transient slices + manual BPM/offset. No demucs, madmom/essentia agreement, or WhisperX. Do the real analysis in Python and load its SliceBank/Grid JSON.
- Not built yet: gestures/preferences (M6), MIDI/lanes/stems export (M7), bench.ts.
- Every threshold in `config.ts` is a [tune] starting value from the plan, not a measurement.
- Intelligibility check is reported as NOT MEASURED.
- Rendering runs on the main thread; move `runScratchAgent` into a Worker if it blocks your UI.
- Rendering is deterministic within one JS engine. Bit-identical WAVs across engines/platforms depend on `Math.sin` implementations, so NOT MEASURED across browsers.

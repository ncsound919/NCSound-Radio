# Stem separation integration plan

Status: **plan**; **S0 (install + measure) done 2026-10-07** — see §0b. Companion to
`apps/dj-console/REDESIGN-PLAN.md` Phase 7B (browser stems = no-go on this PC),
`docs/CLOUDFLARE-INTEGRATION.md` §5 (the `ncsound-stems` container), and
`packages/station-core/src/contract/analysis.ts` (the stem contract that already
exists). Reviewed 2026-10-07.

Goal in one line: **separate a track into vocals / drums / bass / other once,
offline, cache it, and let the console mix those stems** — with quality and cost
known before anything is shown to the operator.

---

## 0. What is already true (build on this, do not re-decide)

- The cross-process contract already models stems
  (`analysis.ts:31-68`): `AnalysisBundle.stems: string[]`, `StemKind =
  "vocals" | "drums" | "bass" | "other"`, `StemRef { kind, path, uri }`, and an
  `AnalysisJobStatus` that includes `"stems"`. The engine's library-analyze
  command already names `"demucs"` as an analyzer
  (`packages/ingest` / `schema/index.ts:156`).
- The **browser path is ruled out on this PC**: measured ~2.16× realtime on the
  Intel iGPU, projecting a 4-minute track to ~420–520 s
  (`Coding lessons/2026-10-07-demucs-web-stems-no-go-on-this-pc.md`, F1).
  Console stem controls stay hidden (`REDESIGN-PLAN.md:1058`).
- Media already lives in **R2**; the transcoder container already exists
  (`ncsound-transcode`), and the planned stems container is `ncsound-stems`
  (`CLOUDFLARE-INTEGRATION.md:98-103`).
- `analysis/` is a **planned** Python home for essentia/madmom/demucs
  (`README.md:18`); it does not exist yet.

## 0b. S0 result — measured 2026-10-07 (this machine)

Installed `demucs 4.1.0` into `analysis/.venv` (`--system-site-packages`, so the
existing `torch 2.13.0+cpu` is reused; new packages: `demucs`, `julius`,
`lameenc`, `sphn` — all Windows cp312 wheels, no build). Then measured
`htdemucs` on CPU two ways.

**Real music (the number to trust).** Pink Floyd "Comfortably Numb" — a clean,
fully-decoding 381.7 s stereo 44.1 kHz MP3, pre-decoded to WAV:

| Metric | Value |
|---|---|
| Duration | 381.7 s |
| Model load | 4.2 s |
| Separation | 725.7 s |
| Total | 730.0 s |
| **Realtime factor** | **1.91×** |
| Peak RAM | ~1.99 GB |
| Stems (RMS) | drums 0.041 · bass 0.056 · other 0.085 · vocals 0.038 |

**Synthetic control** (180 s mix): 1.25× (three runs 1.25 / 1.31 / 1.37),
~1.46 GB.

The real factor is higher than the synthetic — most likely **sustained-load
thermal throttling** on this U-series laptop (the real run computed for ~12 min
vs ~3.7) and denser spectral content. Use **~1.9×**: a 4-minute track ≈
**7.6 min** single-threaded, ~2 GB RAM.

**Decoder trap (a real finding).** demucs 4.1.0 decodes with `sphn`/symphonia,
which rejects some MP3 frames libsndfile accepts, then falls back to `ffmpeg`
(absent here). Worse, libsndfile **silently truncates** a damaged MP3 at the bad
frame: three NC Sound "Tap" files (header ~404/408/471 s) decoded to only
~209/213/276 s. `analysis/stems/separate.py` now decodes with soundfile and
**verifies the decoded length against the container header before demucs runs**,
refusing a truncation (verified: refuses the damaged Tap file, accepts the clean
one).

**Verdict:** offline CPU separation is viable for a background queue at **~1.9×**
(~7.6 min per 4-minute track, ~2 GB RAM) — far better than the browser's 2.16×,
and duration-bound. Not realtime. Artifacts: `analysis/stems/separate.py`,
`analysis/out/{s0_comfortably_numb.json,s0_htdemucs.json,test_mix.wav}`.

---

## 1. Tooling: which Demucs, installed where

### 1.1 Installed? **Yes** — into `analysis/.venv` (S0, 2026-10-07)

Before S0 it was not installed; S0 installed `demucs 4.1.0` + `julius`,
`lameenc`, `sphn` into an isolated venv reusing the system `torch`. The table
below is the *pre-install* environment survey that scoped the work:

| Check | Result |
|---|---|
| `python -m pip show demucs` | `Package(s) not found: demucs` |
| `demucs` on PATH | not found |
| `python --version` | 3.12.10 (`C:\Program Files\Python312`) |
| `torch` | **2.13.0+cpu** (CPU-only; `cuda=False`, `mps=False`) |
| `python -m pip show torchaudio` | **not installed** |
| `onnxruntime` | 1.17.0 |
| `soundfile` / `librosa` / `numpy` | 0.12.1 / 0.10.1 / 2.4.6 |
| `huggingface_hub` / `safetensors` / `pyyaml` / `tqdm` / `einops` | present |
| `julius` / `lameenc` / `sphn` | **not installed** (demucs-only deps) |
| `ffmpeg` binary | **not on PATH** |
| CPU | Intel i7-10610U, 4 cores / 8 threads; `torch.get_num_threads()=4` |
| C: free | ~24 GB |

### 1.2 Which package: `adefossez/demucs` **v4.1.0**

The `facebookresearch/demucs` repo is archived/read-only; the maintained home is
`adefossez/demucs`. **v4.1.0 (2026-07-11)** is "modernized packaging, lighter
inference dependencies, models on Hugging Face" (MIT).

Its declared runtime requirements (PyPI metadata, exact):

```
einops, huggingface-hub, julius>=0.2.3, lameenc>=1.2, pyyaml, safetensors,
sphn>=0.1.12, tqdm, torch>=2.1
numpy<2   (only darwin/x86_64)
```

Two consequences that de-risk the install:

- **`torchaudio` is no longer a runtime dependency** (only the `train` extra) —
  the inference path uses `sphn`. So the missing `torchaudio` is not a blocker.
- **`numpy<2` applies only to macOS/x86_64.** On Windows, the installed numpy
  2.4.6 is allowed.
- `torch>=2.1` with no upper bound: the installed 2.13.0 satisfies it.
- A `py3-none-any` wheel exists (no build step). Min Python 3.10.

Net new packages: `demucs`, `julius`, `lameenc`, `sphn` (+ small transitive).
`ffmpeg` is now **optional** (needed for FLAC output and formats `sphn` cannot
decode); MP3/WAV decode via `sphn`, WAV output is native.

### 1.3 Alternatives considered

| Tool | What | Verdict |
|---|---|---|
| **`demucs` 4.1.0** | the reference impl; `htdemucs`/`htdemucs_ft`/`htdemucs_6s`/`mdx*` | **default** |
| `demucs-onnx` 0.3.4 | pure numpy+onnxruntime, **no torch at inference** (~50 MB vs ~2 GB), MIT; prebuilt ONNX on HF | strong candidate for the **cloud container** (small image); verify ORT version |
| `audio-separator` 0.47.0 | wraps UVR models incl. **BS-RoFormer**; RoFormer runs on CPU automatically | **later**, for vocals quality (see S5) |

SDR context (MUSDB18-HQ, from the audio-separator model table): `htdemucs` ~9.4
avg, `htdemucs_ft` ~10.1–10.8, **BS-RoFormer vocals 12.9 / instrumental 17.0**.
RoFormer is SOTA but far heavier; htdemucs is the throughput choice.

---

## 2. Decision: offline pre-separation, `htdemucs` default

| Option | Verdict |
|---|---|
| **Offline pre-separation, cached per track** | **chosen** — CPU cost paid once per track, then instant in the console |
| Realtime/browser separation | rejected (2.16× realtime on this PC) |
| Cloud-only (no local) | later (S4); local first proves quality + the job contract cheaply |

**Model policy:** `htdemucs` for batch (default). `htdemucs_ft` only for a
"final render" the operator explicitly asks for (~4× slower). `htdemucs_6s`
only if guitar is needed (piano is documented as poor). `mdx_extra_q` is the
fast/small fallback if throughput bites.

**Output:** demucs writes 44.1 kHz stereo WAV stems (int16). Store the lossless
stems; transcode a playback copy (AAC/Opus/MP3) for the console so 4 stems do
not cost 4× the bandwidth.

---

## 3. Architecture

One **job contract**, two runners. Same inputs and outputs either way, so the
cloud move is a deployment change, not a rewrite.

```
 library track (R2) ──► stems job ──► 4 stems + manifest ──► R2 ──► console
                          │
        (S1) local runner: analysis/ venv, demucs.api.Separator
        (S4) cloud runner: ncsound-stems container, Queue message
```

- **Cache key:** a content hash of the source audio (the repo already uses
  content-hash caching — see the `content-hash-cache-pattern` skill). Re-import
  of the same audio must not re-separate.
- **Manifest:** an `AnalysisBundle`-shaped JSON per track
  (`analysis.ts:31-41`) with `analyzer: "demucs"`, `stems: StemKind[]`, and
  `StemRef[]` carrying the R2 `uri`. Store beside the stems.
- **Storage layout (R2):**
  `stems/<trackId>/<model>/<contentHash>/vocals.wav` (+ `drums`,`bass`,`other`)
  and `…/manifest.json`. Playback copies under `…/playback/vocals.m4a` etc.

---

## 4. Data model & API

- **Data model:** the stem set is derivable from R2 + the manifest. Optionally
  add a `StemSet` row to `apps/station-web/prisma/schema.prisma` (trackId,
  model, contentHash, status, manifestKey, createdAt) so the site/console can
  list "has stems" without an R2 listing. Do this only when the console needs
  to query it (S2).
- **Enqueue:** `POST /api/ops/stems` (admin, like `api/ops/slots`) or the
  planned Worker `POST /stems/:id` (`CLOUDFLARE-INTEGRATION.md:93`). Body:
  `{ trackId, model? }`.
- **Read:** `GET /api/tracks/:id/stems` → manifest + signed URLs. Honest
  `status` (`queued|stems|complete|failed`), never "ready" for a set that is
  not.

---

## 5. Console consumption

- Load the four stems for the on-deck track, **sample-aligned and equal
  length** (they are, by construction) into four synced players.
- Per-stem **gain / mute / solo**; instant **acapella** (vocals solo) and
  **instrumental** (vocals mute).
- Reuse the existing deck/mixer timeline for sync; do not build a second
  transport.
- Gate: keep stem controls **hidden** until S0 measures an acceptable factor on
  the station PC (`REDESIGN-PLAN.md:1058`).

---

## 6. Phased tasks & acceptance

- **S0 — install + measure (the gate).** Create an isolated venv
  (`analysis/.venv`, gitignored), `pip install demucs` (4.1.0), run `htdemucs`
  on one real 3–4 min stereo track, record wall time + realtime factor + peak
  RAM. *Accept:* factor measured and recorded; a decision on CPU-local vs
  cloud-only. (The demucs README claims CPU ≈ 1.5× track length; treat that as
  unverified until measured here.)
- **S1 — local runner.** `analysis/stems/separate.py` (thin wrapper over
  `demucs.api.Separator`) that writes the 4 stems + an `AnalysisBundle` manifest
  to a target dir. *Accept:* a CLI call produces 4 non-silent, aligned stems for
  a real track.
- **S2 — storage + API.** Upload stems + manifest to R2; add the enqueue/read
  routes. *Accept:* `GET …/stems` returns the manifest and playable URLs.
- **S3 — console.** Synced 4-stem player with gain/mute/solo. *Accept:* toggling
  vocals mute changes the mix live with no drift over a track.
- **S4 — cloud runner.** `ncsound-stems` container (optionally `demucs-onnx` for
  a small image), Queue-driven. *Accept:* the same job runs cloud-side and the
  console cannot tell which runner made the stems.
- **S5 (later) — vocals quality.** Add BS-RoFormer via `audio-separator` for
  acapella-specific jobs.

---

## 7. Risks

- **CPU speed — resolved by S0.** Real music measured **1.91×** realtime on this
  CPU (§0b), ~1.99 GB peak RAM (synthetic 1.25×). Viable offline (~7.6 min per
  4-min track); not realtime.
- **Damaged/odd input — guarded.** `sphn` rejects some MP3 frames and libsndfile
  can silently truncate them; `separate.py` verifies decoded length vs the header
  and refuses a truncation (§0b).
- **Model download.** ~80 MB (`htdemucs`) to ~320 MB (`htdemucs_ft`) from
  Hugging Face on first run; the station must be online, and the weights should
  be cached/pinned.
- **`sphn` Windows wheel — resolved.** `sphn 0.2.1` ships a
  `cp312-win_amd64` wheel; no Rust build. `lameenc 1.8.4` likewise.
- **Disk.** C: has ~24 GB free; stems are ~4× a track. Make R2 the store of
  record and keep only the working set local.
- **Legal.** Stems are a **derivative** of the recording. Fine for the operator
  to mix on air under the station's broadcast licences; exposing isolated stems
  to *listeners* (download, on-demand) is a different right and is **not**
  covered by the statutory license (see `MOBILE-LISTENER-APP-IMPLEMENTATION.md`
  §11). Keep stems operator-side unless licensed.

---

## Sources (opened 2026-10-07)

- PyPI `demucs` JSON metadata (v4.1.0 `requires_dist`, wheel/sdist, MIT) —
  primary.
- `github.com/adefossez/demucs` README (maintained fork; v4.1.0 release note;
  model list; CPU "≈1.5× track length" note) — primary.
- `github.com/karaokenerds/python-audio-separator` model/SDR table
  (htdemucs_ft vs BS-RoFormer) — primary (its own benchmark).
- `StemSplitio/htdemucs-ft-onnx` + `demucs-onnx` PyPI (ONNX, no-torch
  inference, MIT) — secondary.
- Local measurements (pip, torch, ffmpeg, CPU) — primary.

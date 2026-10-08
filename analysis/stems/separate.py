"""Offline stem separation (plan S1) + the S0 measurement.

Wraps `demucs.api.Separator` so the engine (or a cloud container, later) can
call one function and get four stems plus a timing/quality summary. The
measurement fields (wall time, realtime factor, peak RAM, per-stem RMS) exist so
"how slow is it here" is answered by a number, not an estimate.

    analysis/.venv/Scripts/python.exe analysis/stems/separate.py TRACK --out DIR

Input handling: the track is decoded with `soundfile` (libsndfile/mpg123) and
verified against the container's own length *before* demucs runs. Two real traps
this avoids:

  * demucs 4.1.0's own decoder (`sphn`/symphonia) rejects some MP3 frames that
    libsndfile accepts, then falls back to `ffmpeg` — which may not be installed;
  * libsndfile can *silently truncate* a damaged MP3 at the bad frame (a 404 s
    file decoded to 209 s). Separating half a track without saying so is the
    exact silent failure this guard exists to stop.

Writes `<out>/<stem>.wav` for each stem and prints a JSON summary on the last line.
"""

import argparse
import json
import sys
import time
from pathlib import Path


def peak_rss_bytes() -> int:
    """Peak working set of this process (Windows) / max RSS (POSIX)."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        # Restype matters: an unset HANDLE restype truncates the pseudo-handle
        # on 64-bit, the call then fails, and an unchecked result reads 0 MB.
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(ProcessMemoryCounters),
            wintypes.DWORD,
        ]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL

        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(ProcessMemoryCounters)
        if not psapi.GetProcessMemoryInfo(
            kernel32.GetCurrentProcess(),
            ctypes.byref(counters),
            ctypes.sizeof(ProcessMemoryCounters),
        ):
            return 0
        return int(counters.PeakWorkingSetSize)

    import resource

    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024


def decode_and_verify(src: Path, work_dir: Path) -> tuple[Path, float]:
    """Decode to float32, verify length against the header, return a WAV path.

    Raises on a truncated decode rather than separating a partial track.
    """
    import numpy as np
    import soundfile as sf

    info = sf.info(str(src))
    audio, samplerate = sf.read(str(src), dtype="float32", always_2d=True)
    decoded = int(audio.shape[0])
    duration = decoded / samplerate

    expected = int(info.frames)
    if expected:
        # 2 % (or one second) of tolerance absorbs MP3 frame padding; anything
        # larger is a damaged file, not encoder slop.
        tolerance = max(samplerate, int(expected * 0.02))
        if abs(decoded - expected) > tolerance:
            raise SystemExit(
                f"decode truncated for {src.name}: header says {expected / samplerate:.1f}s "
                f"but only {duration:.1f}s decoded — the file is damaged; refusing to "
                f"separate half a track. Re-rip or re-encode it first."
            )

    if np.max(np.abs(audio)) == 0:
        raise SystemExit(f"{src.name} decodes to silence; nothing to separate.")

    if src.suffix.lower() == ".wav" and decoded == expected:
        return src, duration

    work = work_dir / "input.wav"
    sf.write(str(work), audio, samplerate, subtype="PCM_16")
    return work, duration


def separate_file(
    input_path: str,
    out_dir: str,
    model: str = "htdemucs",
    device: str = "cpu",
    shifts: int = 1,
    progress: bool = False,
) -> dict:
    import numpy as np
    import soundfile as sf
    from demucs.api import Separator

    src = Path(input_path)
    dest = Path(out_dir)
    dest.mkdir(parents=True, exist_ok=True)
    work, duration = decode_and_verify(src, dest)

    t_load = time.perf_counter()
    separator = Separator(model=model, device=device, shifts=shifts, progress=progress)
    load_s = time.perf_counter() - t_load

    t_sep = time.perf_counter()
    _origin, separated = separator.separate_audio_file(work)
    separate_s = time.perf_counter() - t_sep

    stems: dict[str, dict] = {}
    for name, tensor in separated.items():
        arr = tensor.detach().cpu().numpy()
        if arr.ndim == 2:  # (channels, samples) -> (samples, channels)
            arr = arr.T
        path = dest / f"{name}.wav"
        sf.write(str(path), arr, separator.samplerate, subtype="PCM_16")
        rms = float(np.sqrt((np.asarray(arr, dtype="float64") ** 2).mean()))
        stems[name] = {"path": str(path), "rms": round(rms, 6), "peak": round(float(np.max(np.abs(arr))), 5)}

    total_s = load_s + separate_s
    return {
        "input": str(src),
        "model": model,
        "device": device,
        "shifts": shifts,
        "sample_rate": int(separator.samplerate),
        "channels": int(sf.info(str(work)).channels),
        "duration_sec": round(duration, 3),
        "model_load_sec": round(load_s, 3),
        "separate_sec": round(separate_s, 3),
        "total_sec": round(total_s, 3),
        "realtime_factor": round(total_s / duration, 3),
        "peak_ram_mb": round(peak_rss_bytes() / 1_048_576, 1),
        "stems": stems,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Separate a track into stems and report timing.")
    ap.add_argument("input")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--shifts", type=int, default=1)
    args = ap.parse_args()

    summary = separate_file(args.input, args.out, args.model, args.device, args.shifts, progress=True)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

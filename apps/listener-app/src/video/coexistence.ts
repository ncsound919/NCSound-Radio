import { engine } from '../player/engine';

/**
 * Audio/video hand-off.
 *
 * The live video carries the same program audio OBS captured, so exactly one
 * source may play at a time — otherwise the program is heard twice and drifts.
 * Watch pauses the audio player; leaving Watch resumes it (at the live edge,
 * since the radio stream reopens rather than seeking).
 */
export function enterWatch(): void {
  engine.pause();
}

export function exitWatch(): void {
  engine.play();
}

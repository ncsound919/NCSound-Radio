/**
 * Who may issue which control command.
 *
 * Deny by default: a role not listed here can only read (`query.*`). `ops` and
 * `console` are the station owner and keep everything. `host` (the morning
 * show) and `guest` get an explicit allowlist of command types.
 *
 * What a live guest actually needs is small, because their own audio does not
 * go through these commands at all: it goes over the `/live` socket. These
 * commands drive the headless engine (autopilot, imaging, the request queue),
 * so the allowlists below are about what a person may do to the station's
 * automation while they are on the air or around it. Edit the sets to taste;
 * `test/multiuser.test.ts` pins the intent.
 */

import type { ActorRole } from "@ncsound/station-core";

/** Morning show: can steer the rotation a little, cannot stop the station. */
const HOST_COMMANDS: ReadonlySet<string> = new Set([
  "imaging.play",
  "cue.request",
  "cue.track",
  "mix.skip",
  "mix.mixNext",
]);

/** Guest DJ: imaging and listener requests only. */
const GUEST_COMMANDS: ReadonlySet<string> = new Set(["imaging.play", "cue.request"]);

/**
 * Reads a session may not reach through the command channel.
 *
 * A blanket `query.*` grant let a host/guest pull `query.crate` (the whole
 * library) and `query.setlist` (play history), which `SESSION_READS` deliberately
 * denies them over HTTP. The command channel must not be a wider door than the
 * GET path.
 */
const SESSION_DENIED_QUERIES: ReadonlySet<string> = new Set(["query.crate", "query.setlist"]);

export function rolePermits(role: ActorRole, commandType: string): boolean {
  if (commandType.startsWith("query.")) {
    if ((role === "host" || role === "guest") && SESSION_DENIED_QUERIES.has(commandType)) return false;
    return true;
  }
  switch (role) {
    case "ops":
    case "console":
      return true;
    case "host":
      return HOST_COMMANDS.has(commandType);
    case "guest":
      return GUEST_COMMANDS.has(commandType);
    default:
      return false; // automation, system: read-only over this surface
  }
}

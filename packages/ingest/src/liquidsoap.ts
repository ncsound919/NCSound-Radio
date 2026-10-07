/**
 * Liquidsoap command client.
 *
 * Liquidsoap's telnet server (:1234) is how a running stream is reconfigured
 * without a restart. This is the only route to the off-air switch added in
 * `infra/liquidsoap/ncsound.liq`: `var.set on_air = false` puts the output on
 * `blank()`, which is the difference between "the engine stopped" and "the
 * station is off air".
 *
 * Why this lives in ingest and not in the apps: ingest already owns the
 * Liquidsoap harbor (it pushes PCM into :8008) and already knows whether the
 * engine is playing. Having one process own both sides of the same boundary
 * means the off-air state cannot drift from the engine state, and the apps
 * keep talking to a single service.
 *
 * Two properties worth stating, because both are load-bearing:
 *
 *  - The telnet server has NO authentication (Liquidsoap documents this and
 *    recommends restricting access at the OS layer). It is bound to 127.0.0.1
 *    and must stay that way. This client connects to loopback only.
 *  - `var.get on_air` is the authority on whether the station is on air, not
 *    our own memory of what we last set. If a human flipped it over telnet, or
 *    Liquidsoap restarted, this is what reports the truth.
 */

import { connect } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LiquidsoapOptions = {
  host?: string;
  port?: number;
  /** Give up on connect/speak rather than hanging a command. */
  timeoutMs?: number;
  /**
   * Where the operator's on-air intent is remembered.
   *
   * Liquidsoap's own `interactive.persistent` was rejected: it round-trips an
   * undocumented internal format that `interactive.bool` cannot satisfy, and
   * the failure is an uncaught runtime crash at boot. Keeping the intent here
   * also keeps the control plane in one process — ingest already owns the
   * harbor on the other side of the same boundary.
   */
  statePath?: string;
};

export type OnAirState = {
  /** null = could not be determined; never guess true. */
  onAir: boolean | null;
  error: string | null;
};

export class LiquidsoapControl {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly statePath: string | null;
  /** Last state we successfully set; null until we know it. */
  private desired: boolean | null = null;

  constructor(opts: LiquidsoapOptions = {}) {
    this.host = opts.host ?? process.env.LIQUIDSOAP_HOST ?? "127.0.0.1";
    this.port = opts.port ?? Number(process.env.LIQUIDSOAP_PORT ?? 1234);
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.statePath = opts.statePath === undefined ? null : opts.statePath;
  }

  /**
   * Restore the remembered on-air state onto a freshly started Liquidsoap.
   *
   * Without this, restarting Liquidsoap silently returns an off-air station to
   * air — `interactive.bool("on_air", true)` defaults to true. Call this once
   * the daemon is up.
   *
   * Note the precedence this implies: ingest is authoritative for the switch.
   * Flipping it by hand over telnet is an emergency override that ingest will
   * undo on its next restart; there is no way to distinguish the two from here.
   */
  async restore(): Promise<{ restored: boolean; to: boolean | null }> {
    if (!this.statePath) return { restored: false, to: null };
    let stored: boolean;
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as { onAir?: unknown };
      if (typeof raw.onAir !== "boolean") throw new Error("onAir was not a boolean");
      stored = raw.onAir;
    } catch {
      // No state yet: that means the operator has never taken us off air, and
      // the Liquidsoap default (true) is correct.
      return { restored: false, to: null };
    }
    try {
      await this.setOnAir(stored);
      return { restored: true, to: stored };
    } catch {
      return { restored: false, to: stored };
    }
  }

  private remember(on: boolean): void {
    this.desired = on;
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify({ onAir: on }), "utf8");
    } catch {
      /* the switch still works; it just will not survive a restart */
    }
  }

  /** The state this process last asked for, or null if it never has. */
  get desiredOnAir(): boolean | null {
    return this.desired;
  }

  /**
   * Run one telnet command and collect the reply up to the `END` marker.
   *
   * The protocol is line-oriented: a command's output is terminated by a line
   * reading `END`. Resolving on `close` alone would work but is slower and
   * loses the reply to a trailing socket error.
   */
  private command(line: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      let out = "";
      let settled = false;

      const finish = (err: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value ?? out);
      };

      const timer = setTimeout(
        () => finish(new Error(`liquidsoap did not answer "${line}" within ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );

      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${line}\nexit\n`));
      socket.on("data", (chunk: string) => {
        out += chunk;
        // The banner and prompt are noise; stop at the first END.
        if (/(^|\n)END(\r?\n|$)/.test(out)) finish(null, out);
      });
      socket.on("error", (err) => finish(err));
      socket.on("close", () => finish(null, out));
    });
  }

  /** Read the authoritative on-air state. */
  async onAir(): Promise<OnAirState> {
    try {
      const raw = await this.command("var.get on_air");
      // Replies look like: true / false / Failure to get ...
      if (/\btrue\b/i.test(raw)) return { onAir: true, error: null };
      if (/\bfalse\b/i.test(raw)) return { onAir: false, error: null };
      return { onAir: null, error: `unexpected var.get reply: ${raw.trim().slice(0, 120)}` };
    } catch (err) {
      return { onAir: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Is the engine's upload actually feeding Liquidsoap?
   *
   * Read from `input.harbor`'s own `on_connect`/`on_disconnect` callbacks, which
   * the script publishes as an interactive variable.
   *
   * This exists because the client-side flag could not be trusted. Across a full
   * Liquidsoap restart the publisher reported `connected=true, reconnects=0,
   * lastError=null` while uploading into a dead socket and the mount served
   * -91 dBFS: writing to a socket never fails when the peer is gone, so nothing on
   * the client ever noticed. Liquidsoap knows, because it owns the other end.
   *
   * Distinct from `onAir()`, which is the operator's *intent*. This is the fact.
   */
  async harborSourceConnected(): Promise<OnAirState> {
    try {
      const raw = await this.command("var.get harbor_source_connected");
      if (/\btrue\b/i.test(raw)) return { onAir: true, error: null };
      if (/\bfalse\b/i.test(raw)) return { onAir: false, error: null };
      return { onAir: null, error: `unexpected var.get reply: ${raw.trim().slice(0, 120)}` };
    } catch (err) {
      return { onAir: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send several commands down one connection and collect the whole reply.
   *
   * Liquidsoap's telnet server serves one client at a time, so a second
   * connection does not run in parallel with the first — it waits. Anything that
   * needs more than one value must therefore ask for them together.
   */
  private session(lines: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      let out = "";
      let settled = false;

      const finish = (err: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value ?? out);
      };

      const timer = setTimeout(
        () => finish(new Error(`liquidsoap did not answer within ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );

      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${lines.join("\n")}\nexit\n`));
      socket.on("data", (chunk) => {
        out += chunk;
        // The banner and prompt are noise; stop when every value has arrived.
        const wanted = lines.length;
        const seen = (out.match(/^(true|false)\s*$/gm) ?? []).length;
        if (seen >= wanted || /(^|\n)END(\r?\n|$)/.test(out)) finish(null, out);
      });
      socket.on("error", (err) => finish(err));
      socket.on("close", () => finish(null, out));
    });
  }

  /**
   * Read several variables over ONE telnet session.
   *
   * Liquidsoap's telnet server handles a single client at a time, so opening a
   * second connection to ask a second question does not run in parallel — it
   * queues behind the first, and the caller waits out `timeoutMs`. That is what
   * made `/status` hang: it asks for `on_air` and `harbor_source_connected`, and
   * the second probe blocked the request until the client gave up.
   *
   * Asking for both in one session keeps the round-trip count at one.
   */
  private async readVars(names: string[]): Promise<Record<string, boolean | null>> {
    const out: Record<string, boolean | null> = {};
    if (names.length === 0) return out;
    try {
      const raw = await this.session(names.map((n) => `var.get ${n}`));
      // Replies look like: true / false / Failure to get ...
      for (const name of names) {
        const m = new RegExp(`(?:^|\\n)${name}[^\\n]*\\n(true|false)\\b`, "i").exec(raw);
        out[name] = m ? m[1].toLowerCase() === "true" : null;
      }
    } catch {
      for (const name of names) out[name] = null;
    }
    return out;
  }

  /**
   * Read the switch and the harbor source state together.
   *
   * Both come from Liquidsoap and both are needed for every `/status`, so they are
   * fetched in one session rather than two.
   */
  async onAirAndHarborSource(): Promise<{
    onAir: { onAir: boolean | null; error: string | null };
    harborSource: { onAir: boolean | null; error: string | null };
  }> {
    const vars = await this.readVars(["on_air", "harbor_source_connected"]);
    const onAir = vars.on_air;
    const source = vars.harbor_source_connected;
    return {
      onAir: {
        onAir,
        error: onAir === null ? "var.get on_air returned nothing readable" : null,
      },
      harborSource: {
        onAir: source,
        error:
          source === null
            ? "var.get harbor_source_connected returned nothing readable (is the rendered config older than this build?)"
            : null,
      },
    };
  }

  /**
   * Is the console's live upload feeding the `live` mount?
   *
   * The live analogue of `harborSourceConnected()`. Going on air is decided by
   * Liquidsoap, not by the operator pressing a button: ffmpeg starts feeding
   * harbor immediately, but autopilot is still on the mount until Liquidsoap
   * switches to the live source.
   */
  async liveHarborConnected(): Promise<OnAirState> {
    try {
      const raw = await this.command("var.get live_harbor_connected");
      if (/\btrue\b/i.test(raw)) return { onAir: true, error: null };
      if (/\bfalse\b/i.test(raw)) return { onAir: false, error: null };
      return { onAir: null, error: `unexpected var.get reply: ${raw.trim().slice(0, 120)}` };
    } catch (err) {
      return { onAir: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Put the station on air, or take it off. Throws if Liquidsoap refuses. */
  async setOnAir(on: boolean): Promise<void> {
    const raw = await this.command(`var.set on_air = ${on ? "true" : "false"}`);
    if (/failure|error|invalid/i.test(raw)) {
      throw new Error(`liquidsoap refused var.set on_air: ${raw.trim().slice(0, 160)}`);
    }
    this.remember(on);
  }

  /** Convenience for the emergency path: off, then confirm it took. */
  async takeOffAir(): Promise<OnAirState> {
    await this.setOnAir(false);
    return this.onAir();
  }
}

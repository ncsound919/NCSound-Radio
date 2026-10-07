/**
 * One typed store for the redesigned console.
 *
 * Replaces the legacy pattern of 35 module-level mutable `let`s read from
 * anywhere. Views subscribe to a selector and re-render only when the selected
 * slice changes (compared by reference, so update immutably).
 */
export type Listener<S> = (state: S, prev: S) => void;

export class Store<S extends object> {
  private state: S;
  private listeners = new Set<Listener<S>>();

  constructor(initial: S) {
    this.state = initial;
  }

  get(): S {
    return this.state;
  }

  /** Shallow-merge a patch, or derive one from the current state. */
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void {
    const prev = this.state;
    const next = { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) };
    this.state = next;
    for (const l of this.listeners) l(next, prev);
  }

  /** Call `fn` with the selected slice now and whenever it changes. Returns an unsubscribe. */
  select<T>(selector: (s: S) => T, fn: (value: T) => void): () => void {
    let last = selector(this.state);
    fn(last);
    const listener: Listener<S> = (s) => {
      const v = selector(s);
      if (v !== last) {
        last = v;
        fn(v);
      }
    };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

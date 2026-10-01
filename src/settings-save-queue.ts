export type SettingsSaveStatus = "pending" | "saving" | "saved" | "error";

export interface SettingsSaveQueue<T extends object> {
  readonly draft: T;
  edit(next: T): void;
  flush(): Promise<void>;
  receive(saved: T): T;
  dispose(): void;
}

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;

export function createSettingsSaveQueue<T extends object>(
  initial: T,
  persist: (patch: Partial<T>) => Promise<void>,
  notify: (status: SettingsSaveStatus, error?: string) => void,
): SettingsSaveQueue<T> {
  let draft = copy(initial);
  let saved = copy(initial);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let retryAfterRunning = false;
  const dirty = new Set<string>();
  const inFlight = new Set<string>();

  const schedule = (delay = 250): void => {
    if (disposed || timer || dirty.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed) return;
      if (running) {
        retryAfterRunning = true;
        return;
      }
      void drain().catch(() => undefined);
    }, delay);
  };

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const drain = (): Promise<void> => {
    if (disposed || dirty.size === 0) return Promise.resolve();
    if (running) return running;

    const task = (async (): Promise<void> => {
      while (!disposed && dirty.size > 0) {
        const sentKeys = [...dirty];
        const patch: Record<string, unknown> = {};
        const draftRecord = draft as Record<string, unknown>;

        for (const key of sentKeys) {
          patch[key] = draftRecord[key];
          inFlight.add(key);
        }

        const sent = copy(patch);
        notify("saving");

        try {
          await persist(copy(sent) as Partial<T>);
        } catch (error) {
          for (const key of sentKeys) inFlight.delete(key);
          if (!disposed) {
            notify("error", error instanceof Error ? error.message : String(error));
          }
          if (!disposed) throw error;
          return;
        }

        if (disposed) return;

        const current = draft as Record<string, unknown>;
        const savedRecord = saved as Record<string, unknown>;
        for (const key of sentKeys) {
          inFlight.delete(key);
          if (sameJson(current[key], sent[key])) {
            savedRecord[key] = copy(sent[key]);
            dirty.delete(key);
          }
        }
      }

      if (!disposed) notify("saved");
    })();

    running = task;
    void task.then(
      () => {
        if (running === task) running = undefined;
        retryAfterRunning = false;
      },
      () => {
        if (running === task) running = undefined;
        if (!disposed && retryAfterRunning) {
          retryAfterRunning = false;
          schedule(0);
        }
      },
    );

    return task;
  };

  return {
    get draft(): T {
      return draft;
    },

    edit(next: T): void {
      if (disposed) return;

      const previous = draft as Record<string, unknown>;
      draft = copy(next);
      const current = draft as Record<string, unknown>;
      const savedRecord = saved as Record<string, unknown>;
      const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);

      for (const key of keys) {
        if (sameJson(previous[key], current[key])) continue;
        if (!inFlight.has(key) && sameJson(current[key], savedRecord[key])) {
          dirty.delete(key);
        } else {
          dirty.add(key);
        }
      }

      if (dirty.size === 0) {
        clearTimer();
        notify("saved");
        return;
      }

      notify("pending");
      clearTimer();
      schedule();
    },

    flush(): Promise<void> {
      if (disposed) return Promise.resolve();
      clearTimer();
      retryAfterRunning = false;
      return drain();
    },

    receive(remote: T): T {
      if (disposed) return draft;

      const incoming = copy(remote) as Record<string, unknown>;
      const current = draft as Record<string, unknown>;
      const savedRecord = saved as Record<string, unknown>;

      for (const key of Object.keys(incoming)) {
        if (dirty.has(key) || inFlight.has(key)) continue;
        const value = copy(incoming[key]);
        savedRecord[key] = value;
        current[key] = copy(value);
      }

      return draft;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimer();
      retryAfterRunning = false;
    },
  };
}

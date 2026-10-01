import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createSettingsSaveQueue } from "../src/settings-save-queue";

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test("debounces edits and saves only the final dirty patch", async () => {
  const writes: Array<Partial<{ name: string; size: number }>> = [];
  const queue = createSettingsSaveQueue(
    { name: "one", size: 12 },
    async (patch) => {
      writes.push(patch);
    },
    () => undefined,
  );

  queue.edit({ name: "two", size: 12 });
  queue.edit({ name: "three", size: 12 });
  await wait(300);
  await queue.flush();

  assert.deepEqual(writes, [{ name: "three" }]);
});

test("serializes writes when an edit arrives during a save", async () => {
  const writes: Array<Partial<{ value: number }>> = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const queue = createSettingsSaveQueue(
    { value: 1 },
    async (patch) => {
      writes.push(patch);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (writes.length === 1) await firstWrite;
      active -= 1;
    },
    () => undefined,
  );

  queue.edit({ value: 2 });
  const flushing = queue.flush();
  queue.edit({ value: 3 });
  releaseFirst();
  await flushing;

  assert.deepEqual(writes, [{ value: 2 }, { value: 3 }]);
  assert.equal(maximumActive, 1);
});

test("an old broadcast cannot overwrite a newer in-flight draft", async () => {
  const writes: Array<Partial<{ title: string; size: number }>> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queue = createSettingsSaveQueue(
    { title: "old", size: 12 },
    async (patch) => {
      writes.push(patch);
      if (writes.length === 1) await gate;
    },
    () => undefined,
  );

  queue.edit({ title: "first", size: 12 });
  const flushing = queue.flush();
  queue.edit({ title: "newer", size: 12 });
  queue.receive({ title: "old", size: 14 });

  assert.deepEqual(queue.draft, { title: "newer", size: 14 });
  release();
  await flushing;
  assert.deepEqual(writes, [{ title: "first" }, { title: "newer" }]);
});

test("receive merges untouched external fields", () => {
  const queue = createSettingsSaveQueue(
    { theme: "light", size: 12 },
    async () => undefined,
    () => undefined,
  );

  queue.edit({ theme: "dark", size: 12 });
  const received = queue.receive({ theme: "light", size: 16 });

  assert.deepEqual(received, { theme: "dark", size: 16 });
});

test("a failed flush retains the draft and a later flush retries", async () => {
  let attempts = 0;
  const queue = createSettingsSaveQueue(
    { enabled: false },
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
    },
    () => undefined,
  );

  queue.edit({ enabled: true });
  await assert.rejects(queue.flush(), /offline/);
  assert.deepEqual(queue.draft, { enabled: true });

  await queue.flush();
  assert.equal(attempts, 2);
});

test("dispose cancels pending saves", async () => {
  let writes = 0;
  const queue = createSettingsSaveQueue(
    { enabled: false },
    async () => {
      writes += 1;
    },
    () => undefined,
  );

  queue.edit({ enabled: true });
  queue.dispose();
  await queue.flush();

  assert.equal(writes, 0);
});

test('debounce waits after the latest edit, not the first edit', async () => {
  const writes: unknown[] = [];
  const queue = createSettingsSaveQueue({ value: 0 }, async patch => { writes.push(patch); }, () => {});
  queue.edit({ value: 1 });
  await wait(180);
  queue.edit({ value: 2 });
  await wait(110);
  assert.equal(writes.length, 0);
  await queue.flush();
  assert.deepEqual(writes, [{ value: 2 }]);
  queue.dispose();
});

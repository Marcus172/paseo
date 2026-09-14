import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createFileObserver, type FileChange } from "../index.js";
import { createNativeRecursiveBackend } from "./native-recursive.js";
import { createObserverPaths } from "./paths.js";

// Native watchers may coalesce file removals into change notifications. Keep the
// filesystem real while controlling which notifications reach reconciliation.
test("shallow parent scans retain nested change scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-scopes-"));
  const paths = createObserverPaths(process.platform);
  const removed = [
    join(root, "root.txt"),
    join(root, "child", "child.txt"),
    join(root, "child", "deep", "deep.txt"),
  ];
  await mkdir(join(root, "child", "deep"), { recursive: true });
  await Promise.all(removed.map((path) => writeFile(path, "before")));
  const events: FileChange[] = [];
  const notifications = new EventEmitter();
  let active = true;
  const observer = createFileObserver();
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: (type, path) => events.push({ type, path }),
      fail: (error) => {
        throw error;
      },
    },
    paths,
    (_root, listener) => {
      notifications.on("change", listener);
      return {
        close: () => {
          notifications.removeAllListeners();
        },
        on: (event, onError) => notifications.on(event, onError),
      };
    },
  );
  try {
    await backend.start();
    await Promise.all(removed.map((path) => rm(path)));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    for (const path of removed) notifications.emit("change", "change", path);
    await vi.advanceTimersByTimeAsync(8_000);
    vi.useRealTimers();
    await expect
      .poll(() =>
        events
          .filter((event) => event.type === "delete")
          .map((event) => event.path)
          .sort(),
      )
      .toEqual([...removed].sort());
  } finally {
    vi.useRealTimers();
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a file announced only as changed remains visible to coalesced deletion scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-change-only-"));
  const directory = join(root, "nested");
  await mkdir(directory);
  const paths = createObserverPaths(process.platform);
  const events: FileChange[] = [];
  const notifications = new EventEmitter();
  let active = true;
  const observer = createFileObserver();
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: (type, path) => events.push({ type, path }),
      fail: (error) => {
        throw error;
      },
    },
    paths,
    (_root, listener) => {
      notifications.on("change", listener);
      return {
        close: () => notifications.removeAllListeners(),
        on: (event, onError) => notifications.on(event, onError),
      };
    },
  );
  try {
    await backend.start();
    const path = join(directory, "changed.txt");
    await writeFile(path, "created");
    notifications.emit("change", "change", path);
    await expect.poll(() => backend.getDiagnostics().nativeTrackedFileCount).toBe(1);

    await rm(path);
    notifications.emit("change", "change", directory);
    await expect
      .poll(() => events.filter((event) => event.type === "delete"), { timeout: 10_000 })
      .toEqual([{ path, type: "delete" }]);
  } finally {
    vi.useRealTimers();
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});

// One fs.stat per native event is how a single dependency install pins the
// libuv threadpool and the daemon stops answering.
test("a rename burst does not spawn one stat per event", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-classify-"));
  const paths = createObserverPaths(process.platform);
  const notifications = new EventEmitter();
  const observer = createFileObserver();
  let active = true;
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: () => {},
      fail: () => {},
    },
    paths,
    (_root, listener) => {
      notifications.on("change", listener);
      return {
        close: () => notifications.removeAllListeners(),
        on: (event, onError) => notifications.on(event, onError),
      };
    },
  );
  try {
    await backend.start();
    // Emitted synchronously: no stat can settle before the last event lands.
    for (let index = 0; index < 5_000; index += 1) {
      notifications.emit("change", "rename", join(root, `package-${index}`, "index.js"));
    }
    expect(backend.getDiagnostics().pendingClassificationCount).toBeLessThanOrEqual(2_080);
  } finally {
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});

// The shed path is only safe because this backend has a real files/entries
// inventory to diff against. Prove it does the work: force a shed onto an
// already-tracked directory and confirm the create still surfaces.
test("a classification shed onto the scoped audit still recovers the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-shed-"));
  const paths = createObserverPaths(process.platform);
  const shedDirectory = join(root, "shed");
  await mkdir(shedDirectory);
  const events: FileChange[] = [];
  const notifications = new EventEmitter();
  const observer = createFileObserver();
  let active = true;
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: (type, path) => events.push({ type, path }),
      fail: (error) => {
        throw error;
      },
    },
    paths,
    (_root, listener) => {
      notifications.on("change", listener);
      return {
        close: () => notifications.removeAllListeners(),
        on: (event, onError) => notifications.on(event, onError),
      };
    },
  );
  try {
    await backend.start(); // The initial full audit tracks "shed" as known.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

    // Jam the queue exactly as in the burst test above: 32 in flight, 2,048
    // queued, all against a directory that never existed.
    const fillerDirectory = join(root, "filler");
    for (let index = 0; index < 2_048 + 32; index += 1) {
      notifications.emit("change", "rename", join(fillerDirectory, `file-${index}.js`));
    }
    expect(backend.getDiagnostics().pendingClassificationCount).toBe(2_080);

    // A real file lands in the already-tracked "shed" directory while the
    // queue is full, so this event must be shed rather than stat-ed. Written
    // synchronously so no queued stat can settle and free a slot before this
    // event is classified -- that would let it enqueue normally instead of
    // exercising the shed branch.
    const shedPath = join(shedDirectory, "recovered.txt");
    writeFileSync(shedPath, "content");
    notifications.emit("change", "rename", shedPath);

    // 2s clears the mandatory-audit deadline (500ms quiet / 5s max-dirty)
    // that the shed forces by adding "shed" to localScopes, but stays well
    // under the optional-only deadline (8s) that the ambient per-event
    // change-scope audit alone would use. Every event -- shed or not --
    // already schedules that ambient audit, so advancing 8s would recover
    // this file even if the shed branch were a no-op. The short window is
    // what actually proves the shed's own requestAudit call did the work.
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();

    await expect
      .poll(() => events.some((event) => event.type === "create" && event.path === shedPath))
      .toBe(true);
  } finally {
    vi.useRealTimers();
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});

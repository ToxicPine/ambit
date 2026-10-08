import { assertEquals } from "@std/assert";
import { startHeartbeat } from "@/lib/heartbeat.ts";

Deno.test("heartbeat runs repeatedly and stops its timer", async () => {
  let calls = 0;
  let called!: () => void;
  const twice = new Promise<void>((resolve) => called = resolve);
  const heartbeat = startHeartbeat(() => {
    if (++calls === 2) called();
    return Promise.resolve();
  }, 1);
  try {
    await twice;
  } finally {
    await heartbeat.stop();
  }
  assertEquals(calls, 2);
  assertEquals(heartbeat.signal.aborted, false);
});

for (const synchronous of [false, true]) {
  Deno.test(`heartbeat ${synchronous ? "throw" : "rejection"} aborts associated work with the original error`, async () => {
    const error = new Error("heartbeat failed");
    const heartbeat = startHeartbeat(() => {
      if (synchronous) throw error;
      return Promise.reject(error);
    }, 1);
    try {
      await new Promise<void>((resolve) =>
        heartbeat.signal.addEventListener("abort", () => resolve(), {
          once: true,
        })
      );
      assertEquals(heartbeat.signal.reason, error);
    } finally {
      await heartbeat.stop();
    }
  });
}

Deno.test("stopping cancels an in-flight heartbeat before cleanup", async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => started = resolve);
  let aborted = false;
  const heartbeat = startHeartbeat((signal) => {
    started();
    return new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true })
    );
  }, 1);
  await running;
  await heartbeat.stop();
  assertEquals(aborted, true);
  assertEquals(heartbeat.signal.aborted, false);
});

Deno.test("an unresponsive heartbeat times out and aborts associated work", async () => {
  const heartbeat = startHeartbeat(
    (signal) =>
      new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      ),
    1,
    5,
  );
  try {
    await new Promise<void>((resolve) =>
      heartbeat.signal.addEventListener("abort", () => resolve(), {
        once: true,
      })
    );
    assertEquals(heartbeat.signal.reason.name, "TimeoutError");
  } finally {
    await heartbeat.stop();
  }
});

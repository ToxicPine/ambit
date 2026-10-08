import { assertEquals, assertRejects } from "@std/assert";
import process from "node:process";
import { runWithSignals } from "@/lib/signals.ts";

Deno.test("signal handlers are removed after success or failure", async () => {
  const counts = ["SIGINT", "SIGTERM"].map((name) =>
    process.listenerCount(name)
  );
  await runWithSignals(() => Promise.resolve());
  await assertRejects(
    () => runWithSignals(() => Promise.reject(new Error("failed"))),
    Error,
    "failed",
  );
  assertEquals(
    ["SIGINT", "SIGTERM"].map((name) => process.listenerCount(name)),
    counts,
  );
});

Deno.test("OS signals allow cleanup, with a deadline and second-signal escape", async (t) => {
  const dir = await Deno.makeTempDir();
  const source = new URL("../lib/signals.ts", import.meta.url).href;
  const bundle = `${dir}/signals.mjs`;
  try {
    const built = await new Deno.Command(Deno.execPath(), {
      args: ["bundle", "--no-config", "--output", bundle, source],
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(built.code, 0, new TextDecoder().decode(built.stderr));

    for (const runtime of ["deno", "node"]) {
      for (
        const [signal, mode, code] of [
          ["SIGINT", "cleanup", 130],
          ["SIGTERM", "cleanup", 143],
          ["SIGTERM", "deadline", 143],
          ["SIGTERM", "second", 130],
        ] as const
      ) {
        await t.step(`${runtime}: ${signal}, ${mode}`, async () => {
          const script = `
            import { runWithSignals } from ${
            JSON.stringify(
              runtime === "deno" ? source : new URL(`file://${bundle}`).href,
            )
          };
            await runWithSignals(async (signal) => {
              const active = setInterval(() => {}, 1000);
              try {
                await new Promise((_, reject) => {
                  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                  console.log("ready");
                });
              } finally {
                clearInterval(active);
                console.log("cleaning");
                await new Promise(resolve => ${
            mode === "cleanup" ? "setTimeout(resolve, 30)" : "{}"
          });
                console.log("cleaned");
              }
            }, ${mode === "deadline" ? 100 : 5000});
          `;
          const child = new Deno.Command(
            runtime === "deno" ? Deno.execPath() : "node",
            {
              args: runtime === "deno"
                ? ["eval", "--no-config", script]
                : ["--input-type=module", "--eval", script],
              stdout: "piped",
              stderr: "inherit",
            },
          ).spawn();
          const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
          const reader = child.stdout.pipeThrough(new TextDecoderStream())
            .getReader();
          let output = "";
          const until = async (marker: string) => {
            while (!output.includes(marker)) {
              const { done, value } = await reader.read();
              if (done) throw new Error(`Exited Before ${marker}: ${output}`);
              output += value;
            }
          };
          try {
            await until("ready");
            child.kill(signal);
            if (mode === "second") {
              await until("cleaning");
              child.kill("SIGINT");
            }
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              output += value;
            }
            assertEquals((await child.status).code, code);
            assertEquals(output.includes("cleaning"), true);
            assertEquals(output.includes("cleaned"), mode === "cleanup");
          } finally {
            clearTimeout(watchdog);
            reader.releaseLock();
            try {
              child.kill("SIGKILL");
            } catch { /* Already exited. */ }
            await child.status;
          }
        });
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

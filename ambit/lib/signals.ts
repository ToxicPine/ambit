import process from "node:process";

export async function runWithSignals(
  operation: (signal: AbortSignal) => Promise<void>,
  graceMs = 5000,
): Promise<void> {
  const controller = new AbortController();
  let exitCode: number | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const interrupt = (code: number) => {
    if (exitCode !== undefined) process.exit(code);
    exitCode = code;
    deadline = setTimeout(() => process.exit(code), graceMs);
    controller.abort(new DOMException("Command Interrupted", "AbortError"));
  };
  const onInterrupt = () => interrupt(130);
  const onTerminate = () => interrupt(143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  try {
    await operation(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
  if (exitCode !== undefined) process.exit(exitCode);
}

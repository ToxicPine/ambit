import { assertEquals, assertThrows } from "@std/assert";
import { assertNotRouter, scanFlyToml } from "./guard.ts";

// =============================================================================
// assertNotRouter
// =============================================================================

Deno.test("assertNotRouter: allows normal app names", () => {
  assertNotRouter("my-app");
  assertNotRouter("web-server");
  assertNotRouter("test-123");
});

Deno.test("assertNotRouter: rejects ambit- prefix", () => {
  assertThrows(
    () => assertNotRouter("ambit-browsers-abc123"),
    Error,
    "Cannot deploy ambit infrastructure apps",
  );
});

// =============================================================================
// scanFlyToml - safe configs
// =============================================================================

Deno.test("scanFlyToml: accepts minimal safe config", () => {
  const toml = `
app = "my-app"

[http_service]
  internal_port = 8080
  auto_stop_machines = true
  auto_start_machines = true
`;
  const result = scanFlyToml(toml);
  assertEquals(result.scanned, true);
  assertEquals(result.errors.length, 0);
  assertEquals(result.warnings.length, 0);
});

Deno.test("scanFlyToml: accepts empty config", () => {
  const result = scanFlyToml("");
  assertEquals(result.scanned, true);
  assertEquals(result.errors.length, 0);
});

// =============================================================================
// scanFlyToml - dangerous configs
// =============================================================================

Deno.test("scanFlyToml: rejects force_https", () => {
  const toml = `
app = "my-app"

[http_service]
  internal_port = 8080
  force_https = true
`;
  const result = scanFlyToml(toml);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].includes("force_https"), true);
});

Deno.test("scanFlyToml: rejects TLS on port 443", () => {
  const toml = `
app = "my-app"

[[services]]
  internal_port = 8080
  protocol = "tcp"

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
`;
  const result = scanFlyToml(toml);
  const hasPortError = result.errors.some((e) => e.includes("TLS handler on port 443"));
  assertEquals(hasPortError, true);
});

Deno.test("scanFlyToml: warns on [[services]] blocks", () => {
  const toml = `
app = "my-app"

[[services]]
  internal_port = 8080
  protocol = "tcp"

  [[services.ports]]
    port = 80
    handlers = ["http"]
`;
  const result = scanFlyToml(toml);
  assertEquals(result.errors.length, 0);
  const hasServicesWarn = result.warnings.some((w) => w.includes("[[services]]"));
  assertEquals(hasServicesWarn, true);
});

Deno.test("scanFlyToml: returns error on invalid TOML", () => {
  const result = scanFlyToml("this is not [valid toml {{{{");
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].includes("Failed to parse"), true);
});

import { assertEquals, assertNotEquals } from "@std/assert";
import { buildTools } from "./src/tools.ts";

// =============================================================================
// Tool definition tests (existing)
// =============================================================================

Deno.test("safe mode includes router tools and flycast-only IP allocation", () => {
  const tools = buildTools("safe");
  assertEquals("router_list" in tools, true);
  assertEquals("router_deploy" in tools, true);
  assertEquals("router_destroy" in tools, true);
  assertEquals("router_doctor" in tools, true);
  assertEquals("router_status" in tools, true);
  assertEquals("router_logs" in tools, true);
  assertEquals("fly_ip_allocate_flycast" in tools, true);
});

Deno.test("safe mode excludes public IP and cert tools", () => {
  const tools = buildTools("safe");
  assertEquals("fly_ip_allocate_v4" in tools, false);
  assertEquals("fly_ip_allocate_v6" in tools, false);
  assertEquals("fly_ip_allocate" in tools, false);
  assertEquals("fly_certs_list" in tools, false);
  assertEquals("fly_certs_add" in tools, false);
  assertEquals("fly_certs_remove" in tools, false);
});

Deno.test("unsafe mode includes public IP and cert tools", () => {
  const tools = buildTools("unsafe");
  assertEquals("fly_ip_allocate_v4" in tools, true);
  assertEquals("fly_ip_allocate_v6" in tools, true);
  assertEquals("fly_ip_allocate" in tools, true);
  assertEquals("fly_certs_list" in tools, true);
  assertEquals("fly_certs_add" in tools, true);
  assertEquals("fly_certs_remove" in tools, true);
});

Deno.test("unsafe mode excludes router and flycast-only tools", () => {
  const tools = buildTools("unsafe");
  assertEquals("router_list" in tools, false);
  assertEquals("router_deploy" in tools, false);
  assertEquals("fly_ip_allocate_flycast" in tools, false);
});

Deno.test("common tools present in both modes", () => {
  const safe = buildTools("safe");
  const unsafe = buildTools("unsafe");
  const commonNames = [
    "fly_auth_status", "fly_app_status", "fly_machine_list",
    "fly_machine_start", "fly_machine_stop", "fly_machine_destroy",
    "fly_machine_exec", "fly_ip_list", "fly_ip_release",
    "fly_secrets_list", "fly_secrets_set", "fly_secrets_unset",
    "fly_scale_show", "fly_scale_count", "fly_scale_vm",
    "fly_volumes_list", "fly_volumes_create", "fly_volumes_destroy",
    "fly_config_show", "fly_logs",
  ];
  for (const name of commonNames) {
    assertEquals(name in safe, true, `${name} missing from safe`);
    assertEquals(name in unsafe, true, `${name} missing from unsafe`);
  }
});

Deno.test("templated tools present in both but differ", () => {
  const safe = buildTools("safe");
  const unsafe = buildTools("unsafe");

  // fly_app_create exists in both
  assertEquals("fly_app_create" in safe, true);
  assertEquals("fly_app_create" in unsafe, true);
  // unsafe version has network input, safe does not
  assertEquals("network" in unsafe.fly_app_create.inputSchema, true);
  assertEquals("network" in safe.fly_app_create.inputSchema, false);

  // fly_deploy exists in both
  assertEquals("fly_deploy" in safe, true);
  assertEquals("fly_deploy" in unsafe, true);
  // unsafe version has no_public_ips/flycast/ha inputs, safe does not
  assertEquals("no_public_ips" in unsafe.fly_deploy.inputSchema, true);
  assertEquals("no_public_ips" in safe.fly_deploy.inputSchema, false);

  // fly_app_list descriptions differ
  assertNotEquals(safe.fly_app_list.description, unsafe.fly_app_list.description);
});

// =============================================================================
// Output schema tests
// =============================================================================

Deno.test("every tool has an outputSchema", () => {
  for (const mode of ["safe", "unsafe"] as const) {
    const tools = buildTools(mode);
    for (const [name, def] of Object.entries(tools)) {
      assertEquals(
        typeof def.outputSchema,
        "object",
        `${name} (${mode}) missing outputSchema`,
      );
      assertEquals(
        def.outputSchema !== null,
        true,
        `${name} (${mode}) has null outputSchema`,
      );
    }
  }
});

Deno.test("safe deploy outputSchema has audit field", () => {
  const tools = buildTools("safe");
  assertEquals("audit" in tools.fly_deploy.outputSchema, true);
});

Deno.test("unsafe deploy outputSchema has no audit field", () => {
  const tools = buildTools("unsafe");
  assertEquals("audit" in tools.fly_deploy.outputSchema, false);
});

Deno.test("safe fly_app_create outputSchema has required network", () => {
  const tools = buildTools("safe");
  const schema = tools.fly_app_create.outputSchema;
  assertEquals("network" in schema, true);
  assertEquals("name" in schema, true);
  assertEquals("org" in schema, true);
});

Deno.test("unsafe fly_app_create outputSchema has optional network", () => {
  const tools = buildTools("unsafe");
  const schema = tools.fly_app_create.outputSchema;
  assertEquals("network" in schema, true);
  assertEquals("name" in schema, true);
});

// =============================================================================
// Handler creation tests
// =============================================================================

import { createHandlers } from "./src/handlers.ts";

Deno.test("createHandlers returns handlers for all safe tools", () => {
  const tools = buildTools("safe");
  const handlers = createHandlers("safe");
  for (const name of Object.keys(tools)) {
    assertEquals(
      name in handlers,
      true,
      `handler missing for safe tool: ${name}`,
    );
    assertEquals(
      typeof handlers[name],
      "function",
      `handler for ${name} is not a function`,
    );
  }
});

Deno.test("createHandlers returns handlers for all unsafe tools", () => {
  const tools = buildTools("unsafe");
  const handlers = createHandlers("unsafe");
  for (const name of Object.keys(tools)) {
    assertEquals(
      name in handlers,
      true,
      `handler missing for unsafe tool: ${name}`,
    );
    assertEquals(
      typeof handlers[name],
      "function",
      `handler for ${name} is not a function`,
    );
  }
});

Deno.test("safe handlers do not include unsafe-only tools", () => {
  const handlers = createHandlers("safe");
  assertEquals("fly_ip_allocate_v4" in handlers, false);
  assertEquals("fly_ip_allocate_v6" in handlers, false);
  assertEquals("fly_ip_allocate" in handlers, false);
  assertEquals("fly_certs_list" in handlers, false);
  assertEquals("fly_certs_add" in handlers, false);
  assertEquals("fly_certs_remove" in handlers, false);
});

Deno.test("unsafe handlers do not include safe-only tools", () => {
  const handlers = createHandlers("unsafe");
  assertEquals("router_list" in handlers, false);
  assertEquals("router_deploy" in handlers, false);
  assertEquals("router_destroy" in handlers, false);
  assertEquals("router_doctor" in handlers, false);
  assertEquals("router_status" in handlers, false);
  assertEquals("router_logs" in handlers, false);
  assertEquals("fly_ip_allocate_flycast" in handlers, false);
});

// =============================================================================
// Guard tests
// =============================================================================

import { assertNotRouter } from "./src/guard.ts";
import { assertThrows } from "@std/assert";

Deno.test("assertNotRouter blocks ambit-* apps", () => {
  assertThrows(
    () => assertNotRouter("ambit-browsers-abc123"),
    Error,
    "Cannot operate on ambit infrastructure apps",
  );
  assertThrows(
    () => assertNotRouter("ambit-infra"),
    Error,
    "Cannot operate on ambit infrastructure apps",
  );
});

Deno.test("assertNotRouter allows normal app names", () => {
  // Should not throw
  assertNotRouter("my-app");
  assertNotRouter("browser-worker");
  assertNotRouter("flyroute-typo");
});

// =============================================================================
// Schema validation tests
// =============================================================================

import {
  FlyAppListSchema,
  FlyMachineListSchema,
  FlyIpListSchema,
  FlySecretListSchema,
  FlyVolumeListSchema,
  FlyScaleShowSchema,
  FlyLogEntrySchema,
  FlyAuthSchema,
} from "./src/schemas.ts";

Deno.test("FlyAuthSchema parses valid auth response", () => {
  const data = { email: "user@example.com", extra_field: true };
  const result = FlyAuthSchema.parse(data);
  assertEquals(result.email, "user@example.com");
});

Deno.test("FlyAppListSchema parses app list", () => {
  const data = [
    {
      ID: "app1",
      Name: "my-app",
      Status: "deployed",
      Deployed: true,
      Hostname: "my-app.fly.dev",
      Organization: { Slug: "my-org" },
      Network: "browsers",
    },
  ];
  const result = FlyAppListSchema.parse(data);
  assertEquals(result.length, 1);
  assertEquals(result[0].Name, "my-app");
  assertEquals(result[0].Organization.Slug, "my-org");
});

Deno.test("FlyMachineListSchema parses machine list with nested config", () => {
  const data = [
    {
      id: "m123",
      name: "worker",
      state: "started",
      region: "iad",
      private_ip: "fdaa::1",
      config: {
        guest: {
          cpu_kind: "shared",
          cpus: 1,
          memory_mb: 256,
        },
      },
    },
  ];
  const result = FlyMachineListSchema.parse(data);
  assertEquals(result[0].config?.guest?.cpu_kind, "shared");
});

Deno.test("FlyIpListSchema parses IP list", () => {
  const data = [
    {
      ID: "ip1",
      Address: "fdaa:0:18:a7b:0:1:0:2",
      Type: "private_v6",
      Region: "",
      Network: "browsers",
    },
  ];
  const result = FlyIpListSchema.parse(data);
  assertEquals(result[0].Type, "private_v6");
  assertEquals(result[0].Network, "browsers");
});

Deno.test("FlySecretListSchema parses secrets", () => {
  const data = [
    { Name: "DATABASE_URL", Digest: "abc123", CreatedAt: "2024-01-01T00:00:00Z" },
  ];
  const result = FlySecretListSchema.parse(data);
  assertEquals(result[0].Name, "DATABASE_URL");
});

Deno.test("FlyVolumeListSchema parses volumes", () => {
  const data = [
    {
      id: "vol_123",
      name: "data",
      state: "created",
      size_gb: 10,
      region: "iad",
      encrypted: true,
      attached_machine_id: null,
    },
  ];
  const result = FlyVolumeListSchema.parse(data);
  assertEquals(result[0].size_gb, 10);
  assertEquals(result[0].attached_machine_id, null);
});

Deno.test("FlyScaleShowSchema parses scale info", () => {
  const data = [
    {
      Process: "app",
      Count: 2,
      CPUKind: "shared",
      CPUs: 1,
      Memory: 256,
      Regions: { iad: 1, sea: 1 },
    },
  ];
  const result = FlyScaleShowSchema.parse(data);
  assertEquals(result[0].Process, "app");
  assertEquals(result[0].Regions?.iad, 1);
});

Deno.test("FlyLogEntrySchema parses log entry", () => {
  const data = {
    timestamp: "2024-01-01T00:00:00Z",
    level: "info",
    message: "Listening on :8080",
    region: "iad",
    instance: "m123",
  };
  const result = FlyLogEntrySchema.parse(data);
  assertEquals(result.message, "Listening on :8080");
});

Deno.test("schemas are lenient — passthrough allows extra fields", () => {
  const data = {
    email: "user@example.com",
    unknown_field: "should not error",
    another: 42,
  };
  // Should not throw
  const result = FlyAuthSchema.parse(data);
  assertEquals(result.email, "user@example.com");
});

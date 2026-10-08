import { assertEquals, assertThrows } from "@std/assert";
import {
  FlyMachineLeaseSchema,
  FlyMachineUpdateSchema,
} from "@/schemas/fly.ts";

Deno.test("lease schema retains the API envelope and validates the nonce", () => {
  const response = {
    status: "success" as const,
    data: {
      nonce: "lease",
      expires_at: 1708569778,
      owner: "owner",
      description: "",
      version: "version",
    },
  };
  assertEquals(FlyMachineLeaseSchema.parse(response), response);
  assertThrows(() => FlyMachineLeaseSchema.parse({ status: "error" }));
  assertThrows(() =>
    FlyMachineLeaseSchema.parse({ ...response, data: { nonce: 123 } })
  );
  assertThrows(() =>
    FlyMachineLeaseSchema.parse({ ...response, data: { nonce: "" } })
  );
});

Deno.test("update schema retains Machine fields and requires its instance ID", () => {
  const response = {
    id: "machine",
    name: "router",
    state: "starting" as const,
    region: "sea",
    instance_id: "instance",
    config: { image: "image", metadata: null, env: null },
    image_ref: { digest: "sha256:digest" },
  };
  assertEquals(FlyMachineUpdateSchema.parse(response), response);
  assertThrows(() =>
    FlyMachineUpdateSchema.parse({ ...response, instance_id: undefined })
  );
  assertThrows(() =>
    FlyMachineUpdateSchema.parse({ ...response, instance_id: "" })
  );
});

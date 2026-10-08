import { assertEquals } from "@std/assert";
import { Output } from "@/lib/output.ts";
import { createFlyProvider } from "@/providers/fly.ts";
import { createTailscaleProvider } from "@/providers/tailscale.ts";
import {
  type CreateCtx,
  createTransition,
  hydrateCreate,
} from "@/cli/commands/create/machine.ts";

function context(
  exists = true,
  state: "started" | "stopped" = "started",
): CreateCtx {
  const fly = createFlyProvider("test-token");
  fly.apps.listWithNetwork = () =>
    Promise.resolve(
      exists
        ? [{ name: "ambit-lab-abc123", network: "lab", status: "deployed" }]
        : [],
    );
  fly.machines.list = () =>
    Promise.resolve([{
      id: "machine",
      name: "router",
      state,
      region: "sea",
      private_ip: "fdaa:1:2::3",
    }]);
  return {
    fly,
    tailscale: createTailscaleProvider("test-token"),
    out: new Output(true),
    network: "lab",
    org: "test",
    region: "iad",
    tag: "tag:ambit-lab",
    shouldApprove: false,
    manual: true,
    redeploy: false,
    appName: "",
    routerId: "",
  };
}

Deno.test({
  name: "create chooses creation, reuse, force, or stopped-router recovery",
  permissions: { net: false, run: false },
  async fn() {
    for (
      const [force, exists, state, phase] of [
        [false, true, "started", "complete"],
        [true, true, "started", "deploy_router"],
        [false, true, "stopped", "deploy_router"],
        [true, true, "stopped", "deploy_router"],
        [true, false, "started", "create_app"],
      ] as const
    ) {
      const ctx = context(exists, state);
      assertEquals(await hydrateCreate(ctx, { force }), phase);
      assertEquals(ctx.redeploy, phase === "deploy_router");
      assertEquals(ctx.appName, exists ? "ambit-lab-abc123" : "");
      assertEquals(ctx.routerId, exists ? "abc123" : "");
      assertEquals(ctx.region, exists ? "sea" : "iad");
    }
  },
});

Deno.test({
  name: "force forwards explicit settings and preserves router secrets",
  permissions: { net: false, run: false },
  async fn() {
    for (const region of [undefined, "sea"]) {
      const ctx = context();
      let deployed = false;
      ctx.fly.deploy.router = (app, _dir, options) => {
        assertEquals(app, "ambit-lab-abc123");
        assertEquals(options, { region: "sea" });
        deployed = true;
        return Promise.resolve();
      };
      ctx.fly.secrets.set = () => {
        throw new Error("Existing secrets must be preserved");
      };
      const phase = await hydrateCreate(ctx, { force: true, region });
      assertEquals((await createTransition(phase, ctx)).unwrap(), "complete");
      assertEquals(deployed, true);
    }
  },
});

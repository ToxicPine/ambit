import { assertEquals, assertRejects } from "@std/assert";
import {
  createFlyProvider,
  FlyDeployError,
  type FlyProvider,
} from "@/providers/fly.ts";

const app = "ambit-lab-abc123";
const machinesPath = `/v1/apps/${app}/machines`;
const machinePath = `${machinesPath}/machine`;
const config = {
  image: "old-image",
  guest: { cpu_kind: "shared", cpus: 2, memory_mb: 1024 },
  mounts: [{ volume: "vol_existing", path: "/var/lib/tailscale" }],
  env: { NETWORK_NAME: "lab", ROUTER_ID: "abc123" },
  metadata: { custom: "keep" },
};
const permissions = {
  read: true,
  write: true,
  env: true,
  run: true,
  net: false,
};
const machine = {
  id: "machine",
  name: "router",
  region: "sea",
  state: "started",
  config,
};
type Call = {
  path: string;
  method: string;
  body: unknown;
  nonce: string | null;
};
type Options = {
  missing?: boolean;
  buildFails?: boolean;
  updateFails?: boolean;
  releaseFails?: boolean;
};

async function withRouter(
  options: Options,
  test: (
    fly: FlyProvider,
    calls: Call[],
    build: () => Promise<string[]>,
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const oldPath = Deno.env.get("PATH");
  const oldFetch = globalThis.fetch;
  const log = `${dir}/build.json`;
  const held = `${dir}/lease-held`;
  const calls: Call[] = [];
  try {
    await Deno.writeTextFile(
      `${dir}/fly`,
      `#!/usr/bin/env -S ${Deno.execPath()} run --no-config --no-lock --allow-read=${held} --allow-write=${log}
${options.missing ? "" : `await Deno.stat(${JSON.stringify(held)});`}
await Deno.writeTextFile(${JSON.stringify(log)}, JSON.stringify(Deno.args));
${options.buildFails ? 'console.error("build failed"); Deno.exit(1);' : ""}
`,
    );
    await Deno.chmod(`${dir}/fly`, 0o755);
    Deno.env.set("PATH", `${dir}:${oldPath ?? ""}`);
    const replies: Record<string, unknown> = {
      [`GET ${machinesPath}`]: options.missing ? [] : [machine],
      [`POST ${machinePath}/lease`]: {
        status: "success",
        data: { nonce: "lease" },
      },
      [`GET ${machinePath}`]: {
        ...machine,
        config: { ...config, env: { ...config.env, DURING_BUILD: "preserve" } },
      },
      [`POST ${machinePath}`]: { ...machine, instance_id: "new-instance" },
      [`GET ${machinePath}/wait`]: { ok: true },
      [`DELETE ${machinePath}/lease`]: {},
    };
    globalThis.fetch = (input, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      assertEquals(url.origin, "https://api.machines.dev");
      assertEquals(headers.get("Authorization"), "Bearer test-token");
      calls.push({
        path: url.pathname,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        nonce: headers.get("fly-machine-lease-nonce"),
      });
      if (url.pathname.endsWith("/lease")) {
        if (method === "POST") Deno.writeTextFileSync(held, "");
        else Deno.removeSync(held);
      }
      if (url.pathname.endsWith("/wait")) {
        assertEquals(url.searchParams.get("instance_id"), "new-instance");
      }
      const key = method + " " + url.pathname;
      if (!Object.hasOwn(replies, key)) {
        throw new Error("Unexpected request: " + key);
      }
      const failed = (key === "POST " + machinePath && options.updateFails) ||
        (key === "DELETE " + machinePath + "/lease" && options.releaseFails);
      return Promise.resolve(
        failed
          ? new Response("failed", { status: 500 })
          : Response.json(replies[key]),
      );
    };
    const fly = createFlyProvider("test-token");
    fly.auth.getToken = () => Promise.resolve("test-token");
    await test(
      fly,
      calls,
      async () => JSON.parse(await Deno.readTextFile(log)),
    );
  } finally {
    globalThis.fetch = oldFetch;
    if (oldPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", oldPath);
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name:
    "redeploy builds a fresh image, preserves configuration, and releases the lease",
  permissions,
  fn: () =>
    withRouter({}, async (fly, calls, build) => {
      await fly.deploy.router(app, "/bundled/router", { region: "sea" });
      const args = await build();
      assertEquals(args[args.indexOf("--primary-region") + 1], "sea");
      for (
        const flag of ["--build-only", "--push", "--no-cache"]
      ) assertEquals(args.includes(flag), true);
      assertEquals(calls.map((c) => `${c.method} ${c.path}`), [
        `GET ${machinesPath}`,
        `POST ${machinePath}/lease`,
        `GET ${machinePath}`,
        `POST ${machinePath}`,
        `GET ${machinePath}/wait`,
        `DELETE ${machinePath}/lease`,
      ]);
      assertEquals(calls[3].body, {
        config: {
          ...config,
          image: `registry.fly.io/${app}:${
            args[args.indexOf("--image-label") + 1]
          }`,
          env: { ...config.env, DURING_BUILD: "preserve" },
        },
        skip_launch: false,
      });
      for (const call of calls.slice(2)) assertEquals(call.nonce, "lease");
    }),
});

Deno.test({
  name: "missing routers use ordinary deployment without a lease",
  permissions,
  fn: () =>
    withRouter({ missing: true }, async (fly, calls, build) => {
      await fly.deploy.router(app, "/bundled/router", { region: "iad" });
      const args = await build();
      assertEquals(args[args.indexOf("--primary-region") + 1], "iad");
      assertEquals(args.includes("--build-only"), false);
      assertEquals(args.includes("--no-cache"), true);
      assertEquals(calls.length, 1);
    }),
});

Deno.test({
  name: "region mismatch fails before building or leasing",
  permissions,
  fn: () =>
    withRouter({}, async (fly, calls, build) => {
      await assertRejects(
        () => fly.deploy.router(app, "/bundled/router", { region: "iad" }),
        FlyDeployError,
      );
      assertEquals(calls.length, 1);
      await assertRejects(build, Deno.errors.NotFound);
    }),
});

for (
  const [name, options, detail] of [
    ["build failure", { buildFails: true }, "build failed"],
    ["update failure", { updateFails: true }, "Machines API POST"],
    ["release failure", { releaseFails: true }, "Machines API DELETE"],
    [
      "update and release failure",
      { updateFails: true, releaseFails: true },
      "Machines API POST",
    ],
  ] as const
) {
  Deno.test({
    name: `redeploy cleans up after ${name} and retains the appropriate error`,
    permissions,
    fn: () =>
      withRouter(options, async (fly, calls) => {
        const error = await assertRejects(
          () => fly.deploy.router(app, "/bundled/router", { region: "sea" }),
          FlyDeployError,
        );
        assertEquals(error.detail.includes(detail), true);
        assertEquals(calls.at(-1)?.method, "DELETE");
        assertEquals(calls.at(-1)?.nonce, "lease");
      }),
  });
}

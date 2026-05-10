import { z } from "zod";
import { runCommand, type RunOptions } from "@/lib/command.ts";
import { ENV_FLY_API_TOKEN } from "@/util/constants.ts";

const FLY_TOKEN_EXPIRY = "24h";
const FlyTokenJsonSchema = z.union([
  z.string().trim().min(1),
  z.object({
    token: z.string().trim().min(1).optional(),
    access_token: z.string().trim().min(1).optional(),
    accessToken: z.string().trim().min(1).optional(),
    Token: z.string().trim().min(1).optional(),
  }),
]);

export const parseFlyTokenJson = (raw: string): string | null => {
  try {
    const result = FlyTokenJsonSchema.safeParse(JSON.parse(raw));
    if (!result.success) return null;

    const data = result.data;
    if (typeof data === "string") return data;
    return data.token ?? data.access_token ?? data.accessToken ?? data.Token ??
      null;
  } catch {
    return null;
  }
};

export const createFlyOrgToken = async (
  org: string,
  opts?: { baseToken?: string; name?: string; expiry?: string },
): Promise<string | null> => {
  const env = opts?.baseToken
    ? { [ENV_FLY_API_TOKEN]: opts.baseToken }
    : undefined;
  const runOpts: RunOptions | undefined = env ? { env } : undefined;
  const result = await runCommand([
    "fly",
    "tokens",
    "create",
    "org",
    "--json",
    "--org",
    org,
    "--expiry",
    opts?.expiry ?? FLY_TOKEN_EXPIRY,
    "--name",
    opts?.name ?? `ambit ${org}`,
  ], runOpts);

  if (!result.ok) return null;
  return parseFlyTokenJson(result.stdout);
};

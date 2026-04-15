import { fileExists } from "@/lib/cli.ts";

export const selectFlyToken = (rawTokenValue: string): string | null => {
  const tokens = rawTokenValue
    .split(",")
    .map((token) => token.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);

  if (tokens.length === 0) {
    return null;
  }

  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i]?.startsWith("fo1_")) {
      return tokens[i];
    }
  }

  return tokens[tokens.length - 1] ?? null;
};

export const readFlyConfigToken = async (): Promise<string | null> => {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
  const configPath = `${home}/.fly/config.yml`;

  if (!(await fileExists(configPath))) {
    return null;
  }

  const content = await Deno.readTextFile(configPath);
  const match = content.match(/access_token:\s*(.+)/);
  return match?.[1] ? selectFlyToken(match[1]) : null;
};

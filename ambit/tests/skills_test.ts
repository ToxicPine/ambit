import { assertEquals, assertMatch } from "@std/assert";
import { dirname } from "@std/path";
import { skills } from "../lib/skills.ts";

const main = new URL("../main.ts", import.meta.url);
const decoder = new TextDecoder();

const run = async (args: string[]) => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", main.pathname, "skills", ...args],
    // Asset lookup must not depend on the user's working directory.
    cwd: dirname(Deno.execPath()),
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: result.code, stdout: decoder.decode(result.stdout) };
};

Deno.test("skills serves registered guides without authentication", async () => {
  const listed = await run(["list"]);
  assertEquals(listed.code, 0);
  for (const [name, skill] of skills) {
    assertMatch(listed.stdout, new RegExp(name));
    const result = await run(["get", name]);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, await Deno.readTextFile(skill.url) + "\n");
  }
});

Deno.test("skills provides structured JSON results and errors", async () => {
  const listed = await run(["list", "--json"]);
  assertEquals(listed.code, 0);
  assertEquals(JSON.parse(listed.stdout), {
    ok: true,
    skills: Array.from(
      skills,
      ([name, skill]) => ({ name, description: skill.description }),
    ),
  });
  for (const [name, skill] of skills) {
    const result = await run(["get", name, "--json"]);
    assertEquals(result.code, 0);
    assertEquals(JSON.parse(result.stdout), {
      ok: true,
      section: name,
      context: await Deno.readTextFile(skill.url),
    });
  }
  for (
    const args of [["unknown"], ["get"], ["get", "missing"], [
      "get",
      "core",
      "--bad",
    ]]
  ) {
    const result = await run([...args, "--json"]);
    assertEquals(result.code, 1);
    const error = JSON.parse(result.stdout);
    assertEquals(error.ok, false);
    assertEquals(typeof error.error, "string");
  }
});

Deno.test("skills rejects invalid requests", async () => {
  for (
    const args of [
      ["get"],
      ["get", "missing"],
      ["get", "../../deno.json"],
      ["unknown"],
      ["list", "extra"],
      ["get", "core", "extra"],
      ["get", "core", "--unknown"],
    ]
  ) {
    assertEquals((await run(args)).code, 1, args.join(" "));
  }
});

Deno.test("skills exposes usage help", async () => {
  for (const args of [[], ["--help"], ["get", "--help"]]) {
    const result = await run(args);
    assertEquals(result.code, 0);
    assertMatch(result.stdout, /USAGE/);
  }
});

Deno.test("skills rejects unknown subcommands before flags or arguments", async () => {
  for (const args of [["unknown", "--help"], ["unknown", "extra", "--bad"]]) {
    const result = await run(args);
    assertEquals(result.code, 1);
    assertMatch(result.stdout, /Unknown Subcommand: unknown/);
  }
});

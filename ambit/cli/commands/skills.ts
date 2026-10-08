// =============================================================================
// Skills Command - Read Version-Matched Agent Guides
// =============================================================================

import { parseArgs } from "@std/cli";
import { registerCommand } from "@/cli/mod.ts";
import { checkArgs } from "@/lib/args.ts";
import { bold } from "@/lib/cli.ts";
import { createOutput } from "@/lib/output.ts";
import { skills } from "@/lib/skills.ts";

const showSkillsHelp = (): void => {
  console.log(`
${bold("ambit skills")} - Read Agent Guides Shipped With This CLI

${bold("USAGE")}
  ambit skills list [--json]
  ambit skills get <name> [--json]

${bold("SUBCOMMANDS")}
  list   List registered guides
  get    Read a registered guide

${bold("EXAMPLES")}
  ambit skills get core
  ambit skills list --json
`);
};

const runSkills = async (argv: string[]): Promise<void> => {
  const opts = { boolean: ["help", "json"] } as const;
  const args = parseArgs(argv, opts);
  const [subcommand, name] = args._;

  switch (subcommand) {
    case undefined:
      checkArgs(args, opts, "ambit skills", 0);
      return showSkillsHelp();

    case "list": {
      checkArgs(args, opts, "ambit skills list", 1);
      if (args.help) return showSkillsHelp();
      const out = createOutput<{
        skills: { name: string; description: string }[];
      }>(args.json);
      const registered = Array.from(skills, ([name, skill]) => ({
        name,
        description: skill.description,
      }));
      for (const skill of registered) {
        out.text(`  ${skill.name.padEnd(12)} ${skill.description}`);
      }
      out.done({ skills: registered }).print();
      return;
    }

    case "get": {
      checkArgs(args, opts, "ambit skills get", 2);
      if (args.help) return showSkillsHelp();
      const out = createOutput<{ section: string; context: string }>(args.json);
      if (typeof name !== "string" || !name) {
        return out.die(
          "Missing Skill Name. Run 'ambit skills list' for Available Guides.",
        );
      }
      const skill = skills.get(name);
      if (!skill) {
        return out.die(
          `Unknown Skill: ${name}. Run 'ambit skills list' for Available Guides.`,
        );
      }
      const content = await Deno.readTextFile(skill.url).catch((error) =>
        out.die(error instanceof Error ? error.message : String(error))
      );
      out.text(content).done({ section: name, context: content }).print();
      return;
    }

    default: {
      const out = createOutput<Record<string, never>>(args.json);
      return out.die(
        `Unknown Subcommand: ${subcommand}. Run 'ambit skills --help' for Usage.`,
      );
    }
  }
};

registerCommand({
  name: "skills",
  description: "Read agent guides shipped with this CLI",
  usage: "ambit skills list|get <name> [--json]",
  run: runSkills,
});

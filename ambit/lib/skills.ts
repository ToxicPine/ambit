// =============================================================================
// Skills - Registered Guides From the Skills Submodule
// =============================================================================

export interface Skill {
  description: string;
  url: URL;
}

export const skills = new Map<string, Skill>([
  ["core", {
    description:
      "Ambit CLI commands, workflows, ACL guidance, and troubleshooting",
    url: new URL("../skills/ambit-cli/SKILL.md", import.meta.url),
  }],
]);

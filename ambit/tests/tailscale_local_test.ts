import { assertEquals } from "@std/assert";
import { unpatchAclTagReferences } from "@/util/tailscale-local.ts";

Deno.test("unpatchAclTagReferences removes ACL rules whose destination references the tag", () => {
  const policy = {
    acls: [
      {
        action: "accept",
        src: ["group:team"],
        dst: ["tag:ambit-lab:53"],
      },
      {
        action: "accept",
        src: ["group:team"],
        dst: ["fdaa:1234::/48:*"],
      },
    ],
  };

  assertEquals(unpatchAclTagReferences(policy, "tag:ambit-lab"), {
    acls: [
      {
        action: "accept",
        src: ["group:team"],
        dst: ["fdaa:1234::/48:*"],
      },
    ],
  });
});

Deno.test("unpatchAclTagReferences removes tag entries from mixed ACL rules", () => {
  const policy = {
    acls: [
      {
        action: "accept",
        src: ["group:team", "tag:ambit-lab"],
        dst: ["tag:ambit-lab:53", "tag:shared:443"],
      },
    ],
  };

  assertEquals(unpatchAclTagReferences(policy, "tag:ambit-lab"), {
    acls: [
      {
        action: "accept",
        src: ["group:team"],
        dst: ["tag:shared:443"],
      },
    ],
  });
});

Deno.test("unpatchAclTagReferences is a no-op when no ACL rules reference the tag", () => {
  const policy = {
    acls: [
      {
        action: "accept",
        src: ["group:team"],
        dst: ["fdaa:1234::/48:*"],
      },
    ],
  };

  assertEquals(
    unpatchAclTagReferences(policy, "tag:ambit-lab"),
    policy,
  );
});

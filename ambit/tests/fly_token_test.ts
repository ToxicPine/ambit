import { assertEquals } from "@std/assert";
import { readFlyConfigToken, selectFlyToken } from "@/util/fly-token.ts";

Deno.test("selectFlyToken prefers a trailing fo1 token from Fly config", () => {
  const raw = "fm2_old_token,fm2_older_token,fo1_real_api_token";

  assertEquals(selectFlyToken(raw), "fo1_real_api_token");
});

Deno.test("selectFlyToken falls back to the last token when fo1 is absent", () => {
  const raw = "fm2_first_token,fm2_latest_token";

  assertEquals(selectFlyToken(raw), "fm2_latest_token");
});

Deno.test("readFlyConfigToken normalizes comma-separated access_token values", async () => {
  const home = await Deno.makeTempDir();
  const originalHome = Deno.env.get("HOME");
  const originalUserProfile = Deno.env.get("USERPROFILE");

  try {
    await Deno.mkdir(`${home}/.fly`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.fly/config.yml`,
      'access_token: fm2_old_token, "fo1_real_api_token"\n',
    );

    Deno.env.set("HOME", home);
    Deno.env.delete("USERPROFILE");

    assertEquals(await readFlyConfigToken(), "fo1_real_api_token");
  } finally {
    if (originalHome === undefined) {
      Deno.env.delete("HOME");
    } else {
      Deno.env.set("HOME", originalHome);
    }

    if (originalUserProfile === undefined) {
      Deno.env.delete("USERPROFILE");
    } else {
      Deno.env.set("USERPROFILE", originalUserProfile);
    }

    await Deno.remove(home, { recursive: true });
  }
});

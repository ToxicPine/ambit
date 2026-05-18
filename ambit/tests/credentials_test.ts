import { assertEquals } from "@std/assert";
import {
  createConfigCredentialStore,
  getFlyIdentityKey,
} from "@/util/credentials.ts";

Deno.test("getFlyIdentityKey scopes personal to the Fly user email", () => {
  assertEquals(
    getFlyIdentityKey("personal", "Alice@Example.com"),
    "fly:user:alice@example.com",
  );
});

Deno.test("getFlyIdentityKey scopes non-personal orgs by global slug", () => {
  assertEquals(
    getFlyIdentityKey("My-Org", "alice@example.com"),
    "fly:org:my-org",
  );
});

Deno.test("credential store reads only scoped keys", async () => {
  const originalHome = Deno.env.get("HOME");
  const dir = await Deno.makeTempDir();
  Deno.env.set("HOME", dir);

  try {
    const store = createConfigCredentialStore();
    await store.setTailscaleApiKey("org-key", "fly:org:acme");

    assertEquals(await store.getTailscaleApiKey("fly:org:acme"), "org-key");
    assertEquals(await store.getTailscaleApiKey("fly:org:other"), null);
  } finally {
    if (originalHome === undefined) {
      Deno.env.delete("HOME");
    } else {
      Deno.env.set("HOME", originalHome);
    }
    await Deno.remove(dir, { recursive: true });
  }
});

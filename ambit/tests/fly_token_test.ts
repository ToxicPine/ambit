import { assertEquals } from "@std/assert";
import { parseFlyTokenJson } from "@/util/fly-token.ts";

Deno.test("parseFlyTokenJson reads the token field from fly tokens JSON", () => {
  const raw = JSON.stringify({ token: "FlyV1 org scoped token" });

  assertEquals(parseFlyTokenJson(raw), "FlyV1 org scoped token");
});

Deno.test("parseFlyTokenJson accepts alternate access token field names", () => {
  const raw = JSON.stringify({ access_token: "FlyV1 access token" });

  assertEquals(parseFlyTokenJson(raw), "FlyV1 access token");
});

Deno.test("parseFlyTokenJson rejects invalid JSON", () => {
  assertEquals(parseFlyTokenJson("not json"), null);
});

Deno.test("parseFlyTokenJson rejects JSON without a token", () => {
  assertEquals(parseFlyTokenJson(JSON.stringify({ id: "123" })), null);
});

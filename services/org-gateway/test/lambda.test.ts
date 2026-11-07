import { afterEach, describe, expect, it, vi } from "vitest";

const SENDER = "0x1111111111111111111111111111111111111111";
const PROOF = `0x${"ab".repeat(64)}`;

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, val] of Object.entries(env)) vi.stubEnv(k, val);
  return import("../src/lambda.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("lambda handler", () => {
  it("proxies GET and POST to the first good upstream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) =>
        u.includes("good") ? new Response(JSON.stringify({ data: PROOF })) : new Response("x", { status: 500 }),
      ),
    );
    const { handler } = await load({ L2_UPSTREAMS: "https://bad.invalid,https://good.invalid", L2_BUDGET_MS: "500" });
    const get = await handler({ rawPath: `/l2/${SENDER}/0x31c1980f.json`, requestContext: { http: { method: "GET" } } });
    expect(JSON.parse(get.body)).toEqual({ data: PROOF });
    expect(get.headers["x-l2-upstream"]).toBe("https://good.invalid");
    const post = await handler({
      rawPath: "/l2",
      requestContext: { http: { method: "POST" } },
      body: Buffer.from(JSON.stringify({ sender: SENDER, data: "0x31c1980f" })).toString("base64"),
      isBase64Encoded: true,
    });
    expect(JSON.parse(post.body)).toEqual({ data: PROOF });
  });

  it("answers 0x when upstreams fail, serves the fallback and health, and gates senders", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const { handler } = await load({ L2_UPSTREAMS: "https://down.invalid", L2_BUDGET_MS: "200", ORG_RESOLVER: SENDER });
    const r = await handler({ rawPath: `/l2/${SENDER}/0x31c1980f.json`, requestContext: { http: { method: "GET" } } });
    expect(JSON.parse(r.body)).toEqual({ data: "0x" });
    const other = await handler({
      rawPath: `/l2/0x2222222222222222222222222222222222222222/0x31.json`,
      requestContext: { http: { method: "GET" } },
    });
    expect(other.statusCode).toBe(404);
    const fb = await handler({ rawPath: "/l2-fallback.json", requestContext: { http: { method: "GET" } } });
    expect(JSON.parse(fb.body)).toEqual({ data: "0x" });
    const h = await handler({ rawPath: "/health", requestContext: { http: { method: "GET" } } });
    expect(JSON.parse(h.body).ok).toBe(true);
    const bad = await handler({ rawPath: `/l2/not-an-address/0x00.json`, requestContext: { http: { method: "GET" } } });
    expect(bad.statusCode).toBe(400);
  });
});

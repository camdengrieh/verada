import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { findNode22, pickPort, portIsFree, readEnvFile, redact, secretsOf } from "./lib.mjs";

test("secretsOf collects the url, credentials, long path segments and query values", () => {
  const url = "https://user:hunter2hunter2@rpc.example.com/v2/abcdef0123456789?apikey=zzzzzzzzzz&x=1";
  const s = secretsOf(url);
  assert.ok(s.includes(url));
  assert.ok(s.includes("hunter2hunter2"));
  assert.ok(s.includes("abcdef0123456789"));
  assert.ok(s.includes("zzzzzzzzzz"));
  assert.ok(!s.includes("v2"));
  assert.ok(!s.includes("1"));
});

test("redact removes every secret, longest first", () => {
  const url = "https://rpc.example.com/v2/abcdef0123456789";
  const text = `Fork: ${url}\nkey abcdef0123456789 seen\nrequest to ${url} failed`;
  const out = redact(text, secretsOf(url));
  assert.ok(!out.includes("abcdef0123456789"));
  assert.ok(!out.includes("rpc.example.com/v2"));
  assert.match(out, /Fork: <redacted>/);
});

test("redact with no secrets leaves the text alone", () => {
  assert.equal(redact("plain", []), "plain");
  assert.deepEqual(secretsOf(""), []);
});

test("pickPort returns a free port above 20000 and skips taken ones", async () => {
  const a = await pickPort();
  assert.ok(a >= 20_000);
  const b = await pickPort([a]);
  assert.notEqual(a, b);
});

test("portIsFree sees a listening port", async () => {
  const srv = createServer();
  await new Promise((r) => srv.listen({ port: 0, host: "127.0.0.1" }, r));
  const { port } = srv.address();
  assert.equal(await portIsFree(port), false);
  await new Promise((r) => srv.close(r));
  assert.equal(await portIsFree(port), true);
});

test("readEnvFile parses KEY=VALUE, quotes and export, ignores comments", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = join(mkdtempSync(join(tmpdir(), "dev-env-")), "env");
  writeFileSync(f, '# c\nFORK_RPC_URL="https://x.test/k"\nexport A=1\n  B = two \n');
  assert.deepEqual(readEnvFile(f), { FORK_RPC_URL: "https://x.test/k", A: "1", B: "two" });
  assert.deepEqual(readEnvFile(join(tmpdir(), "does-not-exist-dev-env")), {});
});

test("findNode22 honours the running node when it is new enough", () => {
  const major = Number(process.versions.node.split(".")[0]);
  const found = findNode22({ NVM_DIR: "/nonexistent" });
  if (major >= 23 || (major === 22 && Number(process.versions.node.split(".")[1]) >= 12)) assert.equal(found, process.execPath);
  else assert.ok(found === null || typeof found === "string");
});

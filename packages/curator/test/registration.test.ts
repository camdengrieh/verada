import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi } from "viem";
import { ERC8004_IDENTITY_REGISTRY, registerCallsFromRecord, registrationDataUri, registrationFile } from "../src/registration.js";

const record = JSON.parse(readFileSync(new URL("../../../agents/curators.json", import.meta.url), "utf8"));

describe("ERC-8004 registration", () => {
  it("builds a cause's registration file", () => {
    const f = registrationFile("hunger");
    expect(f).toMatchObject({ type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "hunger.agent.varada.eth", active: true, registrations: [] });
    expect(f.services).toEqual([
      { name: "web", endpoint: "https://hunger.agent.varada.eth.limo" },
      { name: "ENS", endpoint: "hunger.agent.varada.eth", version: "v2" },
    ]);
    expect(f.description).toContain('"relief" agent with disaster');
    expect(registrationFile("water", { agentId: 7n }).registrations).toEqual([{ agentId: 7, agentRegistry: `eip155:1:${ERC8004_IDENTITY_REGISTRY}` }]);
    expect(() => registrationFile("nope")).toThrow(/unknown cause/);
  });

  it("encodes it as a self-contained data URI", () => {
    const uri = registrationDataUri(registrationFile("hunger"));
    expect(uri.startsWith("data:application/json;base64,")).toBe(true);
    expect(JSON.parse(Buffer.from(uri.split(",")[1]!, "base64").toString("utf8")).name).toBe("hunger.agent.varada.eth");
    expect(uri.length).toBeLessThan(1500);
  });

  it("lists the twenty registerAgent calls with each cause's agent signer", () => {
    const calls = registerCallsFromRecord(record);
    expect(calls).toHaveLength(20);
    expect(new Set(calls.map((c) => c.categoryBit)).size).toBe(20);
    const signers = new Map(record.agents.map((a: { agent: string; signer: string }) => [a.agent, a.signer.toLowerCase()]));
    for (const c of calls) expect(c.signer.toLowerCase()).toBe(signers.get(c.agent));
    const hunger = calls.find((c) => c.cause === "hunger")!;
    const disaster = calls.find((c) => c.cause === "disaster")!;
    expect(hunger.signer).toBe(disaster.signer);
    const d = decodeFunctionData({ abi: parseAbi(["function registerAgent(uint8,string,address,string,string)"]), data: hunger.data });
    expect(d.args).toEqual([2, "hunger", hunger.signer, hunger.agentURI, "Varada curator for Hunger & famine"]);
  });
});

import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import {
  ENS_PARENT_NAME,
  dnsEncode,
  isValidLabel,
  labelFromSymbol,
  labelFromName,
  coinEnsName,
  coinParentName,
  isReservedLabel,
  isValidLabel as isValidLabelForName,
  parentNode,
  parseGatewayHostname,
  tokenEnsName,
  tokenLabelhash,
  tokenNode,
  validateLabel,
} from "../src/ens.js";

describe("label rules (mirror LabelLib)", () => {
  it.each([
    ["pepe", true],
    ["abc", true],
    ["a-b", true],
    ["a--bc", true], // hyphens at positions 2-3 are fine
    ["pepe-2024", true],
    ["x".repeat(63), true],
    ["ab", false], // too short
    ["x".repeat(64), false], // too long
    ["Pepe", false], // uppercase
    ["-abc", false],
    ["abc-", false],
    ["ab--c", false], // xn-- slot
    ["xn--abc", false],
    ["a.b", false],
    ["a_b", false],
    ["pépe", false],
    ["", false],
  ])("isValidLabel(%j) = %s", (label, ok) => {
    expect(isValidLabel(label)).toBe(ok);
  });

  it("validateLabel throws on invalid input", () => {
    expect(() => validateLabel("PEPE")).toThrow(/invalid label/);
    expect(validateLabel("pepe")).toBe("pepe");
  });

  it("every accepted label is already ENSIP-15 normalized (lowercase ascii)", () => {
    for (const label of ["pepe", "save-the-world", "token123"]) {
      expect(isValidLabel(label)).toBe(true);
      expect(label.toLowerCase()).toBe(label);
    }
  });
});

describe("labelFromSymbol", () => {
  it.each([
    ["PEPE", "pepe"],
    ["Save The World!", "save-the-world"],
    ["$DOGE", "doge"],
    ["AB", "ab-token"],
    ["xn--foo", "xn-foo"],
    ["---", null],
    ["", null],
    ["ÉCOLE", "ecole"],
  ])("%j -> %j", (symbol, expected) => {
    expect(labelFromSymbol(symbol)).toBe(expected);
  });

  it("truncates long symbols to a valid label", () => {
    const label = labelFromSymbol("a".repeat(70) + "-");
    expect(label).toBe("a".repeat(63));
    expect(isValidLabel(label!)).toBe(true);
  });
});

describe("names and hashes", () => {
  it("builds the subname and matches the on-chain hashing", () => {
    expect(tokenEnsName("pepe")).toBe("pepe.varada.eth");
    expect(tokenLabelhash("pepe")).toBe(keccak256(stringToBytes("pepe")));
    // node = keccak256(parentNode ‖ labelhash)
    const expected = keccak256(
      `0x${parentNode().slice(2)}${tokenLabelhash("pepe").slice(2)}`,
    );
    expect(tokenNode("pepe")).toBe(expected);
  });

  it("dns-encodes names", () => {
    expect(dnsEncode(ENS_PARENT_NAME)).toBe("0x0676617261646103657468" + "00");
    expect(dnsEncode("pepe.varada.eth")).toBe("0x047065706506766172616461036574680" + "0");
  });
});

describe("parseGatewayHostname", () => {
  it.each([
    ["pepe.varada.eth.limo", ".eth.limo", "pepe.varada.eth", "pepe"],
    ["PEPE.varada.eth.limo", ".eth.limo", "pepe.varada.eth", "pepe"],
    ["pepe.varada.eth.link", ".eth.link", "pepe.varada.eth", "pepe"],
    ["pepe.varada.bzz.link", ".bzz.link", "pepe.varada.eth", "pepe"],
    ["varada.eth.limo", ".eth.limo", "varada.eth", null],
    ["varada.bzz.link", ".bzz.link", "varada.eth", null],
    ["a.pepe.varada.eth.limo", ".eth.limo", "a.pepe.varada.eth", null],
    ["ab.varada.eth.limo", ".eth.limo", "ab.varada.eth", null], // invalid label
    ["other.eth.limo", ".eth.limo", "other.eth", null],
  ])("%s", (host, gateway, ensName, label) => {
    expect(parseGatewayHostname(host)).toEqual({ gateway, ensName, label });
  });

  it("returns null for non-gateway hosts", () => {
    expect(parseGatewayHostname("varada.com")).toBeNull();
    expect(parseGatewayHostname("localhost")).toBeNull();
    expect(parseGatewayHostname("eth.limo")).toBeNull();
  });

  it("supports another parent", () => {
    expect(parseGatewayHostname("pepe.other.eth.limo", "other.eth")).toEqual({
      gateway: ".eth.limo",
      ensName: "pepe.other.eth",
      label: "pepe",
    });
  });
});

describe("labelFromName", () => {
  it.each([
    ["Harambe Relief Fund", "harambe-relief-fund"],
    ["Harambe Fund", "harambe-fund"],
    ["  Café   Crème!! ", "cafe-creme"],
    ["Rock & Roll Kids", "rock-and-roll-kids"],
    ["xn--abc", "xn-abc"],
    ["42", null],
    ["!!", null],
    ["Ab", null],
  ])("%s -> %s", (name, expected) => {
    expect(labelFromName(name)).toBe(expected);
  });

  it("is deterministic and always valid", () => {
    for (const n of ["A B C", "Ünïcödé Fund", "a".repeat(80), "word ".repeat(30)]) {
      const l = labelFromName(n);
      expect(l).toBe(labelFromName(n));
      if (l) expect(isValidLabelForName(l)).toBe(true);
    }
  });

  it("cuts long names at a hyphen boundary within 63", () => {
    const l = labelFromName("save the whales ".repeat(10))!;
    expect(l.length).toBeLessThanOrEqual(63);
    expect(l.endsWith("-")).toBe(false);
    expect(l.startsWith("save-the-whales")).toBe(true);
  });

  it("builds coin names and knows the reserved labels", () => {
    expect(coinParentName()).toBe("coin.varada.eth");
    expect(coinEnsName("harambe-fund")).toBe("harambe-fund.coin.varada.eth");
    for (const l of ["org", "coin", "donor", "agent", "names", "endaoment", "varada"]) expect(isReservedLabel(l)).toBe(true);
    expect(isReservedLabel("harambe")).toBe(false);
  });
});

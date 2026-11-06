import { agentByLabel, agentBySlug } from "@varada/sdk";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { curatorOfCause } from "./curators.js";

/** ERC-8004 Identity Registry on Ethereum mainnet. */
export const ERC8004_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/** One service entry of an ERC-8004 registration file. */
export interface RegistrationService {
  name: string;
  endpoint: string;
  version?: string;
}

/** ERC-8004 agent registration file (`agentURI` points at it). */
export interface RegistrationFile {
  type: typeof REGISTRATION_TYPE;
  name: string;
  description: string;
  image?: string;
  services: RegistrationService[];
  x402Support: boolean;
  active: boolean;
  /** Filled once the identity exists (`setAgentURI` after `registerAgent`). */
  registrations: { agentId: number; agentRegistry: string }[];
  supportedTrust: string[];
}

export interface RegistrationOptions {
  /** ENS parent (default `varada.eth`). */
  parent?: string;
  /** The ERC-8004 agent id, once registered. */
  agentId?: bigint | number;
  chainId?: number;
}

/**
 * The registration file of one cause's curator identity. Each of the twenty causes has its own
 * ERC-8004 identity and name `<label>.agent.<parent>`; the agent that runs it (one of ten, two
 * causes each) is named in the description.
 */
export function registrationFile(cause: string, o: RegistrationOptions = {}): RegistrationFile {
  const a = agentByLabel(cause) ?? agentBySlug(cause);
  if (!a) throw new Error(`unknown cause ${cause}`);
  const parent = o.parent ?? "varada.eth";
  const chainId = o.chainId ?? 1;
  const ens = `${a.ensLabel}.agent.${parent}`;
  const runner = curatorOfCause(a.ensLabel);
  const pair = runner ? ` It is run by the "${runner.name}" agent with ${runner.causes.filter((c) => c !== a.ensLabel).join(", ")}, evaluating one of the two every 3 days.` : "";
  return {
    type: REGISTRATION_TYPE,
    name: ens,
    description:
      `Varada curator for ${a.label}. Each epoch it researches the cause's news in eight regions, ranks up to 32 ` +
      `Endaoment charities per region for the next token ballots, publishes the picks on chain with a signed report, ` +
      `and gives from its USDC vault to the charities it ranks.${pair}`,
    services: [
      { name: "web", endpoint: `https://${ens}.limo` },
      { name: "ENS", endpoint: ens, version: "v2" },
    ],
    x402Support: false,
    active: true,
    registrations:
      o.agentId === undefined
        ? []
        : [{ agentId: Number(o.agentId), agentRegistry: `eip155:${chainId}:${ERC8004_IDENTITY_REGISTRY}` }],
    supportedTrust: [],
  };
}

/** `data:application/json;base64,...`: self-contained, so the URI needs no hosting. */
export function registrationDataUri(file: RegistrationFile): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file), "utf8").toString("base64")}`;
}

const registerAgentAbi = [
  {
    type: "function",
    name: "registerAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "categoryBit", type: "uint8" },
      { name: "label", type: "string" },
      { name: "signer", type: "address" },
      { name: "agentURI", type: "string" },
      { name: "description", type: "string" },
    ],
    outputs: [
      { name: "agentId", type: "uint256" },
      { name: "vault", type: "address" },
    ],
  },
] as const;

export interface RegisterCall {
  cause: string;
  categoryBit: number;
  agent: string;
  signer: Address;
  agentURI: string;
  description: string;
  data: Hex;
}

/**
 * The twenty `CuratorRegistry.registerAgent` calls, each cause with its agent's signer (from the
 * `agents/curators.json` record). The registration file has no `registrations` entry yet: set it
 * with `setAgentURI` once the agent id is known.
 */
export function registerCallsFromRecord(
  rec: { agents: { agent: string; signer: string; causes: string[] }[] },
  o: { parent?: string } = {},
): RegisterCall[] {
  const out: RegisterCall[] = [];
  for (const a of rec.agents) {
    for (const label of a.causes) {
      const def = agentByLabel(label);
      if (!def) throw new Error(`unknown cause ${label}`);
      const file = registrationFile(label, { parent: o.parent });
      const agentURI = registrationDataUri(file);
      const description = `Varada curator for ${def.label}`;
      const signer = getAddress(a.signer);
      out.push({
        cause: label,
        categoryBit: def.bit,
        agent: a.agent,
        signer,
        agentURI,
        description,
        data: encodeFunctionData({ abi: registerAgentAbi, functionName: "registerAgent", args: [def.bit, label, signer, agentURI, description] }),
      });
    }
  }
  return out.sort((x, y) => x.categoryBit - y.categoryBit);
}

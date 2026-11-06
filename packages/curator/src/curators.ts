import { agentByLabel, agentBySlug, AGENT_CATEGORIES } from "@varada/sdk";

/**
 * The ten curator agents. Each runs two related causes, evaluating ONE cause in all regions every
 * `ROTATION_DAYS` days and alternating between the two, so each cause gets a fresh curation every
 * 6 days: at least once in every 7-day epoch, which is what the governor needs (a curation applies
 * to exactly one epoch, `currentEpoch() + 1`).
 *
 * On chain nothing changes: every cause keeps its own `CuratorRegistry` entry, `AgentVault`,
 * ERC-8004 identity and `<label>.agent.varada.eth` name; both causes of an agent are registered
 * with the agent's one signer (a 1Claw key). The 1Claw plan allows ten agents, hence ten pairs.
 */
export interface CuratorAgent {
  /** Agent name; the 1Claw agent is `varada-<name>-curator`. */
  name: string;
  /** Cause labels (`ensLabel`), in rotation order. */
  causes: readonly [string, string];
  /** Day offset in the 3-day cycle (0-2), spreading the agents over the days. */
  offset: 0 | 1 | 2;
  /** Daily routine start, UTC `HH:MM`. Every agent runs well before the Thursday 00:00 UTC epoch start. */
  time: string;
}

export const ROTATION_DAYS = 3;
const DAY = 86_400;

export const CURATORS: readonly CuratorAgent[] = [
  { name: "relief", causes: ["disaster", "hunger"], offset: 0, time: "06:00" },
  { name: "housing", causes: ["homeless", "poverty"], offset: 1, time: "06:30" },
  { name: "youth", causes: ["children", "education"], offset: 2, time: "07:00" },
  { name: "health", causes: ["disease", "health"], offset: 0, time: "07:30" },
  { name: "research", causes: ["cancer", "research"], offset: 1, time: "08:00" },
  { name: "animals", causes: ["wildlife", "animals"], offset: 2, time: "08:30" },
  { name: "planet", causes: ["environment", "water"], offset: 0, time: "09:00" },
  { name: "mind", causes: ["mental-health", "veterans"], offset: 1, time: "09:30" },
  { name: "rights", causes: ["human-rights", "women"], offset: 2, time: "10:00" },
  { name: "justice", causes: ["justice", "refugees"], offset: 0, time: "10:30" },
];

export function curatorByName(name: string): CuratorAgent | undefined {
  return CURATORS.find((c) => c.name === name.trim().toLowerCase());
}

/** The agent that runs a cause (label or category slug). */
export function curatorOfCause(cause: string): CuratorAgent | undefined {
  const a = agentByLabel(cause) ?? agentBySlug(cause);
  return a ? CURATORS.find((c) => c.causes.includes(a.ensLabel)) : undefined;
}

export interface DueRun {
  agent: string;
  /** The cause to evaluate on this run (its `ensLabel`). */
  cause: string;
  /** UTC day of the run (Unix days). */
  day: number;
  /** ISO 8601 date, `YYYY-MM-DD`. */
  date: string;
}

const dateOf = (day: number) => new Date(day * DAY * 1000).toISOString().slice(0, 10);
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The run of `agent` on the UTC day containing `at`, or null when it has none that day. */
export function dueOn(agent: CuratorAgent, at: Date): DueRun | null {
  const day = Math.floor(at.getTime() / 1000 / DAY);
  if (mod(day - agent.offset, ROTATION_DAYS) !== 0) return null;
  const run = (day - agent.offset) / ROTATION_DAYS;
  return { agent: agent.name, cause: agent.causes[mod(run, agent.causes.length)]!, day, date: dateOf(day) };
}

/** The next `count` runs of `agent` from the UTC day containing `from` (inclusive). */
export function upcomingRuns(agent: CuratorAgent, from: Date, count: number): DueRun[] {
  const out: DueRun[] = [];
  const start = Math.floor(from.getTime() / 1000 / DAY);
  for (let d = start; out.length < count; d++) {
    const r = dueOn(agent, new Date(d * DAY * 1000));
    if (r) out.push(r);
  }
  return out;
}

/** Routine cron (UTC) for an agent: daily at its time; `due` decides whether the day has a run. */
export function cronOf(agent: CuratorAgent): string {
  const [h, m] = agent.time.split(":").map(Number);
  return `${m} ${h} * * *`;
}

/** Every agent category (except `other`) belongs to exactly one curator, and no cause twice. */
export function checkCurators(curators: readonly CuratorAgent[] = CURATORS): void {
  const seen = new Map<string, string>();
  for (const c of curators) {
    for (const label of c.causes) {
      if (!agentByLabel(label)) throw new Error(`${c.name}: unknown cause ${label}`);
      const other = seen.get(label);
      if (other) throw new Error(`${label} is in both ${other} and ${c.name}`);
      seen.set(label, c.name);
    }
  }
  const missing = AGENT_CATEGORIES.filter((a) => !seen.has(a.ensLabel)).map((a) => a.ensLabel);
  if (missing.length) throw new Error(`causes without a curator: ${missing.join(", ")}`);
}

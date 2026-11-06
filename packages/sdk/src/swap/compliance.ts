/**
 * Ondo tokenized assets can be paused (per token or all at once) and refuse transfers to or from
 * blocked or sanctioned addresses. Both are checked before quoting and sending so the UI can say why
 * a trade cannot go ahead instead of showing a failed transaction.
 */
import type { Address } from "viem";
import { ondoComplianceAbi, ondoPauseManagerAbi, ondoTokenAbi } from "./abis.js";
import { mapSwapError, type SwapReason } from "./errors.js";
import type { ReadClient } from "./pool.js";
import { ONDO_INFRA, isOndoToken, ondoSymbolOf } from "../ondo.js";

export interface ComplianceIssue {
  reason: SwapReason;
  /** The token the issue is about (an Ondo token), when it is token-specific. */
  token?: Address;
  symbol?: string;
  message: string;
}

export interface ComplianceReport {
  /** Stops the trade. */
  blockers: ComplianceIssue[];
  /** Does not stop it, but the user should know (market closed: prices may be stale). */
  warnings: ComplianceIssue[];
  /** Ondo tokens that were checked. */
  checked: Address[];
}

export interface ComplianceOptions {
  /**
   * Client for the user's address: `checkIsCompliant(account)` carries it, so this must be the
   * account-scoped private client (docs/PRIVACY.md), never the public one.
   */
  accountClient?: ReadClient;
  account?: Address;
  /**
   * Whether the US market is open (from the app's market calendar). `false` adds a "market-closed"
   * warning, or a blocker when `blockWhenClosed` is set. Omit when unknown.
   */
  marketOpen?: boolean | null;
  blockWhenClosed?: boolean;
}

/** The Ondo tokens in `addresses` (a route's currencies, any case), deduplicated. */
export function ondoTokensIn(addresses: readonly Address[]): Address[] {
  const seen = new Map<string, Address>();
  for (const a of addresses) if (isOndoToken(a)) seen.set(a.toLowerCase(), a);
  return [...seen.values()];
}

async function isPaused(client: ReadClient, token: Address): Promise<boolean> {
  let manager: Address;
  try {
    manager = await client.readContract({ address: token, abi: ondoTokenAbi, functionName: "tokenPauseManager" });
  } catch {
    // USDon has no pause manager getter.
    return false;
  }
  const [paused, all] = await Promise.all([
    client.readContract({ address: manager, abi: ondoPauseManagerAbi, functionName: "isTokenPaused", args: [token] }),
    client.readContract({ address: manager, abi: ondoPauseManagerAbi, functionName: "allTokensPaused" }),
  ]);
  return paused || all;
}

/**
 * The reason a failed `checkIsCompliant` call reverted. `UserSanctioned` is "sanctioned"; any other
 * revert of the compliance view means the address cannot transact, which reads as "blocked".
 * Returns null for errors that are not a contract revert (a dead network must not read as blocked).
 */
export function complianceRevertReason(error: unknown): "blocked" | "sanctioned" | null {
  const mapped = mapSwapError(error);
  if (mapped.reason === "sanctioned" || mapped.reason === "blocked") return mapped.reason;
  const text = JSON.stringify(error, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + String((error as { message?: unknown } | null)?.message ?? "");
  if (/revert/i.test(text) && !/network|fetch|timeout|http request failed/i.test(text)) return "blocked";
  return null;
}

/**
 * Checks every Ondo token among `tokens`: paused, the user's compliance status, and (when given) the
 * market calendar. Non-Ondo tokens are ignored. Read failures of the pause manager are not guessed
 * at: they propagate so the caller shows "network unavailable" rather than "tradable".
 */
export async function checkOndoTradable(client: ReadClient, tokens: readonly Address[], opts: ComplianceOptions = {}): Promise<ComplianceReport> {
  const ondo = ondoTokensIn(tokens);
  const report: ComplianceReport = { blockers: [], warnings: [], checked: ondo };
  if (ondo.length === 0) return report;

  const paused = await Promise.all(ondo.map((t) => isPaused(client, t)));
  ondo.forEach((token, i) => {
    const symbol = ondoSymbolOf(token);
    if (paused[i]) report.blockers.push({ reason: "paused", token, symbol, message: `${symbol ?? "This asset"} is paused by Ondo` });
  });

  if (opts.account && opts.accountClient) {
    try {
      await opts.accountClient.readContract({ address: ONDO_INFRA.complianceGMView, abi: ondoComplianceAbi, functionName: "checkIsCompliant", args: [opts.account] });
    } catch (e) {
      const reason = complianceRevertReason(e);
      if (reason === null) throw e;
      report.blockers.push({ reason, message: reason === "sanctioned" ? "This address is on a sanctions list" : "This address is blocked by Ondo" });
    }
  }

  if (opts.marketOpen === false) {
    const issue: ComplianceIssue = { reason: "market-closed", message: "The US market is closed: prices can be stale until the next open" };
    (opts.blockWhenClosed ? report.blockers : report.warnings).push(issue);
  }
  return report;
}

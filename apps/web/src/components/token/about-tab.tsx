"use client";

import { Card } from "@varada/ui/components/ui/card";
import { EnsAddress } from "@varada/ui/components/varada/ens-address";
import { EnsProfileCard, type EnsTextRecord } from "@varada/ui/components/varada/ens-profile-card";
import { ensLimoUrl } from "@varada/ui/components/varada/ens-shared";
import { TokenLogo } from "@/components/token/token-hero";
import type { TokenDetail } from "@/lib/indexer";
import { profileLinks, safeHref } from "@/lib/token-view";

/** The profile as ENS records plus who is who: creator, controller, editor, fee and metadata. */
export function AboutTab({
  address,
  token,
  ensName,
  label,
  logoUrl,
  texts,
}: {
  address: string;
  token: TokenDetail;
  ensName: string | null;
  label: string | null;
  logoUrl: string | null;
  texts: Readonly<Record<string, string>>;
}) {
  const profile = token.profile;
  const records: EnsTextRecord[] = profileLinks(texts).map((l) => ({
    key: { url: "url", twitter: "com.twitter", telegram: "org.telegram", discord: "com.discord", github: "com.github" }[l.key],
    value: l.text,
    href: l.href ?? undefined,
  }));
  const metadata = token.metadataURI ? (safeHref(token.metadataURI) ?? token.metadataURI) : null;
  return (
    <div className="flex flex-col gap-4">
      {profile?.suppressed ? (
        <p role="note" className="m-0 rounded-2xl bg-sand px-4 py-3 text-sm">
          This profile is suppressed by the registry owner: its ENS records resolve empty.
        </p>
      ) : null}
      {ensName && label ? (
        <EnsProfileCard
          name={ensName}
          description={texts.description}
          avatar={<TokenLogo url={logoUrl} symbol={token.symbol} size={96} />}
          records={records}
          siteHref={ensLimoUrl(ensName)}
          owner={profile?.controller ?? undefined}
        />
      ) : null}
      <Card className="gap-3 p-5">
        <h2 className="m-0 font-sans text-base font-semibold">Details</h2>
        <dl className="m-0 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Row term="Token address">
            <EnsAddress address={address} name={ensName ?? undefined} nameOnly={false} />
          </Row>
          {token.creator ? (
            <Row term="Creator">
              <EnsAddress address={token.creator} />
            </Row>
          ) : null}
          {profile ? (
            <>
              <Row term="Profile controller">{profile.controller ? <EnsAddress address={profile.controller} /> : "none"}</Row>
              <Row term="Profile editor">{profile.editor ? <EnsAddress address={profile.editor} /> : "none"}</Row>
            </>
          ) : null}
          {token.feeBps !== undefined ? <Row term="Trading fee">{`${token.feeBps / 100}% (${token.feeBps} bps), 90% of it to causes`}</Row> : null}
          {metadata ? (
            <Row term="Metadata">
              {safeHref(metadata) ? (
                <a href={metadata} rel="noreferrer noopener" className="break-all underline underline-offset-4">
                  {metadata}
                </a>
              ) : (
                <span className="break-all">{metadata}</span>
              )}
            </Row>
          ) : null}
        </dl>
      </Card>
    </div>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-ink-muted">{term}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </div>
  );
}

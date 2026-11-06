"use client";

import { useState } from "react";
import { Button } from "@varada/ui/components/ui/button";
import { EnsAddress } from "@varada/ui/components/varada/ens-address";
import { EnsClaim, type EnsAvailability, type EnsLookupResult } from "@varada/ui/components/varada/ens-claim";
import { EnsName } from "@varada/ui/components/varada/ens-name";
import { EnsProfileCard } from "@varada/ui/components/varada/ens-profile-card";
import { EnsRecordList, type EditableRecord } from "@varada/ui/components/varada/ens-record-list";
import { ensLimoUrl } from "@varada/ui/components/varada/ens-shared";
import { PaintedImage } from "@varada/ui/components/varada/painted-image";
import { SubnameTree } from "@varada/ui/components/varada/subname-tree";
import { ASSETS } from "@/lib/assets.generated";
import { GallerySection, Specimen } from "../section";

const ADDRESS = "0x7f3a9c2b44e0d1f5a6b7c8d9e0f1a2b3c4d5c21e";
const AGENT_ADDRESS = "0x1c0ffee4a2b9d8e7f6a5b4c3d2e1f0a9b8c7d6e5";

const TAKEN = new Set(["harambe", "gigachad", "pepe", "doge"]);
const RESERVED = new Set(["tiger"]);

/** Sample lookup: a short wait, then a fixed answer per label. */
function sampleCheck(label: string, signal: AbortSignal): Promise<EnsLookupResult> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(TAKEN.has(label) ? "taken" : RESERVED.has(label) ? "reserved" : "available"), 650);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });
}

const STATES: { status: EnsAvailability; value: string }[] = [
  { status: "idle", value: "" },
  { status: "checking", value: "gorilla" },
  { status: "available", value: "gorilla" },
  { status: "taken", value: "harambe" },
  { status: "reserved", value: "tiger" },
  { status: "invalid", value: "ha rambe" },
];

const INITIAL_RECORDS: EditableRecord[] = [
  { key: "description", value: "The gorilla that gives. 90% of every fee goes to wildlife charities.", savedValue: "The gorilla that gives. 90% of every fee goes to wildlife charities." },
  { key: "url", value: "harambe.wtf", savedValue: "harambe.wtf", placeholder: "example.com" },
  { key: "com.twitter", value: "harambe_gives", savedValue: "harambecoin", placeholder: "handle" },
  { key: "org.telegram", value: "harambeportal", savedValue: "harambeportal", placeholder: "group" },
  { key: "com.discord", value: "", savedValue: "", placeholder: "invite code" },
];

function ClaimDemo() {
  const [claimed, setClaimed] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <EnsClaim check={sampleCheck} onClaim={(label) => setClaimed(label)} suggestions={["harambe-gives", "harambe2", "silverback"]} />
      <p className="m-0 text-sm text-ink-muted">
        Try harambe (taken), tiger (reserved for you), ab (too short) or any new name.
        {claimed ? <> Claimed {claimed}.varada.eth in the demo.</> : null}
      </p>
    </div>
  );
}

function RecordsDemo() {
  const [records, setRecords] = useState(INITIAL_RECORDS);
  const [saving, setSaving] = useState(false);
  const save = () => {
    setSaving(true);
    setRecords((rs) => rs.map((r) => (r.value !== r.savedValue ? { ...r, state: "pending" } : r)));
    setTimeout(() => {
      setRecords((rs) => rs.map((r) => ({ ...r, savedValue: r.value, state: undefined })));
      setSaving(false);
    }, 1600);
  };
  return (
    <EnsRecordList
      name="harambe.varada.eth"
      records={records}
      saving={saving}
      onRecordChange={(key, value) => setRecords((rs) => rs.map((r) => (r.key === key ? { ...r, value, state: undefined } : r)))}
      onRecordReset={(key) => setRecords((rs) => rs.map((r) => (r.key === key ? { ...r, value: r.savedValue ?? "", state: undefined } : r)))}
      onSave={save}
    />
  );
}

const coinArt = (key: "cutouts/gorilla-mog" | "cutouts/party-hat" | "cutouts/statue-v1" | "cutouts/tiger-wif-hat") => (
  <PaintedImage name={key} asset={ASSETS[key]} alt="" sizes="28px" />
);

export function EnsSection() {
  return (
    <GallerySection
      id="ens"
      title="ENS names"
      intro="Every coin gets <label>.varada.eth and every curator agent <cause>.agent.varada.eth. The site lives on Swarm, so each name also opens at <name>.limo from its contenthash."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Name" source="Written for Varada">
          <div className="flex flex-col gap-3">
            <EnsName name="harambe.varada.eth" size="lg" verified siteHref={ensLimoUrl("harambe.varada.eth")} />
            <EnsName name="harambe.varada.eth" verified primary />
            <EnsName name="wildlife.agent.varada.eth" siteHref={ensLimoUrl("wildlife.agent.varada.eth")} />
            <EnsName name="tiger-wif-hat.varada.eth" size="sm" copy={false} />
          </div>
        </Specimen>
        <Specimen label="Address chips" source="Written for Varada">
          <div className="flex flex-col items-start gap-2">
            <EnsAddress address={ADDRESS} name="harambe.varada.eth" />
            <EnsAddress address={ADDRESS} name="harambe.varada.eth" direction="both" copyValue="name" />
            <EnsAddress address={AGENT_ADDRESS} name="wildlife.agent.varada.eth" direction="reverse" />
            <EnsAddress address={AGENT_ADDRESS} resolving />
            <EnsAddress address="0x9b2e5f00c1d2e3f4a5b6c7d8e9f0a1b2c3d44a7d" />
          </div>
        </Specimen>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Claim a name" source="21st.dev inline-validation + stamp">
          <ClaimDemo />
        </Specimen>
        <Specimen label="Availability states">
          <div className="flex flex-col gap-4">
            {STATES.map((s) => (
              <EnsClaim key={s.status} label={`State: ${s.status}`} defaultValue={s.value} status={s.status} />
            ))}
          </div>
        </Specimen>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Specimen label="Profile card" source="21st.dev profile-card reveal">
          <EnsProfileCard
            name="harambe.varada.eth"
            description="The gorilla that gives. 90% of every trading fee goes to wildlife charities, paid in USDC."
            avatar={<PaintedImage name="cutouts/gorilla-mog" asset={ASSETS["cutouts/gorilla-mog"]} alt="" sizes="84px" />}
            records={[
              { key: "url", value: "harambe.wtf", href: "https://harambe.wtf" },
              { key: "com.twitter", value: "harambecoin", href: "https://x.com/harambecoin" },
              { key: "org.telegram", value: "harambeportal", href: "https://t.me/harambeportal" },
              { key: "com.discord", value: "harambe" },
              { key: "com.github", value: "harambe-dao" },
            ]}
            contenthash={{ protocol: "swarm", hash: "3f9a1b2c3d4e5f60718293a4b5c6d7e8f9012345c21e" }}
            siteHref={ensLimoUrl("harambe.varada.eth")}
            owner={ADDRESS}
            verified
            actions={<Button variant="outline">Edit profile</Button>}
          />
        </Specimen>
        <Specimen label="Edit text records">
          <RecordsDemo />
        </Specimen>
      </div>

      <Specimen label="Subname tree" source="21st.dev animated-file-tree">
        <SubnameTree
          coins={[
            { label: "harambe", note: "$HARAMBE", art: coinArt("cutouts/gorilla-mog"), href: "#ens" },
            { label: "tiger-wif-hat", note: "$TWH", art: coinArt("cutouts/tiger-wif-hat") },
            { label: "partyhat", note: "$PARTY", art: coinArt("cutouts/party-hat") },
            { label: "statue", note: "$GIVE", art: coinArt("cutouts/statue-v1") },
          ]}
          moreCoins={1284}
          agents={[{ cause: "wildlife" }, { cause: "water" }, { cause: "hunger" }, { cause: "education" }]}
          moreAgents={16}
          active="harambe.varada.eth"
        />
      </Specimen>
    </GallerySection>
  );
}

#!/bin/zsh
# Rebuild the Varada site with the deployed mainnet addresses, upload it to Swarm through the local
# Bee node and point the site feed at it. No chain transaction: the ENS contenthash already points at
# the feed manifest. Run after contracts/deployments/1.json exists.
#
#   pnpm --filter @varada/publish release          # build + upload + feed-update
#   INDEXER_URLS=https://... PUBLISHER_URL=https://... pnpm --filter @varada/publish release
#
# Env: BEE_URL (default http://localhost:1633), BEE_POSTAGE_BATCH_ID (the site batch), SITE_FEED_KEY_FILE
# (default ~/.varada/site-feed.key; the key signs feed chunks only), SITE_FEED_MANIFEST (expected
# feed manifest, printed for the final check), DEPLOYMENTS (default contracts/deployments/1.json).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
DEP=${DEPLOYMENTS:-$REPO/contracts/deployments/1.json}
KEY=${SITE_FEED_KEY_FILE:-$HOME/.varada/site-feed.key}
export BEE_URL=${BEE_URL:-http://localhost:1633}
export BEE_POSTAGE_BATCH_ID=${BEE_POSTAGE_BATCH_ID:-788bfea6fc1f92aa025366e1e00585cfa61727b4d71c06016a23f17569f32911}
EXPECTED_MANIFEST=${SITE_FEED_MANIFEST:-1e617ecfc4c3ed0fcb0bd6338576124e0971793fd4f0962480d33f80edbdd5bf}
FEED_OWNER=${SITE_FEED_OWNER:-0xe896ecbefb0ef3592ecb6b970634ff32b671f4cd}

[ -f "$DEP" ] || { echo "error: $DEP not found (contracts not deployed yet)"; exit 1; }
[ -s "$KEY" ] || { echo "error: feed key $KEY missing"; exit 1; }
curl -sf --max-time 10 "$BEE_URL/readiness" | grep -q '"status":"ready"' || { echo "error: Bee node at $BEE_URL is not ready (docker start bee)"; exit 1; }
curl -sf --max-time 10 "$BEE_URL/stamps/$BEE_POSTAGE_BATCH_ID" | grep -q '"usable":true' || { echo "error: postage batch not usable"; exit 1; }

j() { python3 -c "import json,sys; v=json.load(open('$DEP')).get('$1'); print('' if v is None else v)"; }

export NEXT_PUBLIC_CHAIN_ID=1
export NEXT_PUBLIC_INDEXER_URLS=${INDEXER_URLS:-}
export NEXT_PUBLIC_PUBLISHER_URL=${PUBLISHER_URL:-}
export NEXT_PUBLIC_SWARM_GATEWAY_URL=${SWARM_GATEWAY_URL:-}
export NEXT_PUBLIC_ENS_PARENT_NAME=varada.eth
export NEXT_PUBLIC_ANON_RPC_NETWORK=${ANON_RPC_NETWORK:-nox}
export NEXT_PUBLIC_FACTORY_ADDRESS=$(j factory)
export NEXT_PUBLIC_FACTORY_DEPLOY_BLOCK=$(j deployBlock)
export NEXT_PUBLIC_VAULT_ADDRESS=$(j feeVault)
export NEXT_PUBLIC_GOVERNOR_ADDRESS=$(j epochGovernor)
export NEXT_PUBLIC_DONATION_DISTRIBUTOR_ADDRESS=$(j donationDistributor)
export NEXT_PUBLIC_PROFILE_REGISTRY_ADDRESS=$(j profileRegistry)
export NEXT_PUBLIC_VOTING_SCHEME_ADDRESS=$(j votingScheme)
export NEXT_PUBLIC_TAKEOVER_GOVERNOR_ADDRESS=$(j takeoverGovernor)
export NEXT_PUBLIC_CURATOR_REGISTRY_ADDRESS=$(j curatorRegistry)
unset NEXT_PUBLIC_DEV_PLAIN_BALLOTS

for v in FACTORY_ADDRESS FACTORY_DEPLOY_BLOCK VAULT_ADDRESS GOVERNOR_ADDRESS PROFILE_REGISTRY_ADDRESS VOTING_SCHEME_ADDRESS TAKEOVER_GOVERNOR_ADDRESS CURATOR_REGISTRY_ADDRESS; do
  eval "val=\${NEXT_PUBLIC_$v}"
  [ -n "$val" ] || { echo "error: $v missing in $DEP"; exit 1; }
  echo "NEXT_PUBLIC_$v=$val"
done

cd "$REPO"
echo "== build =="
node packages/publish/bin/varada-publish.mjs build | tail -3

echo "== upload =="
REF=$(node packages/publish/bin/varada-publish.mjs upload --execute --pin --index-document index.html --error-document 404.html | sed -n 's/^swarm reference: //p')
[ ${#REF} -eq 64 ] || { echo "error: upload did not return a reference"; exit 1; }
echo "release reference: $REF"

echo "== feed-update =="
SITE_FEED_PRIVATE_KEY="$(tr -d '\n ' < "$KEY")" node packages/publish/bin/varada-publish.mjs feed-update --ref "$REF" --execute | grep -v -i private
BEE_URL=$BEE_URL node packages/publish/bin/varada-publish.mjs feed-read --owner "$FEED_OWNER" | sed -n 's/^reference: *//p' | grep -q "$REF" && echo "feed now points at $REF"

echo "== check =="
curl -s -o /dev/null -w "local node via feed manifest: HTTP %{http_code}\n" --max-time 60 "$BEE_URL/bzz/$EXPECTED_MANIFEST/"
echo "done. SITE_SWARM_REF stays 0x$EXPECTED_MANIFEST; no chain transaction needed."

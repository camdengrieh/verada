import { Suspense } from "react";
import { TokenDetail } from "@/components/token-detail";

export const metadata = { title: "Token" };

export default function TokenPage() {
  return (
    <Suspense fallback={<p role="status">Loading</p>}>
      <TokenDetail />
    </Suspense>
  );
}

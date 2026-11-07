import type { ReactNode } from "react";

export const metadata = { title: { absolute: "Varada · Design system" } };

/** The gallery renders inside the app shell; styles, fonts and asset resolution come from the root layout. */
export default function DesignLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

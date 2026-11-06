import type { ReactNode } from "react";

/** One gallery section with an anchor for the table of contents. */
export function GallerySection({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex min-w-0 scroll-mt-24 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-3xl font-semibold">{title}</h2>
        {intro ? <p className="max-w-3xl text-muted-foreground">{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A labelled demo tile inside a section. */
export function Specimen({ label, source, children, className }: { label: string; source?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-card p-5 ${className ?? ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="kicker">{label}</span>
        {source ? <span className="text-xs text-muted-foreground">{source}</span> : null}
      </div>
      {children}
    </div>
  );
}

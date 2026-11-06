"use client";
// shadcn/ui new-york, Direction A styling
import { cva, type VariantProps } from "class-variance-authority";
import { Avatar as AvatarPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@verada/ui/lib/utils";

const avatarVariants = cva("relative flex shrink-0 overflow-hidden rounded-full ring-2 ring-paper-card", {
  variants: {
    size: { sm: "size-8 text-xs", md: "size-11 text-sm", lg: "size-14 text-base" },
  },
  defaultVariants: { size: "md" },
});

/** Round avatar. Images come from the site's own assets; the fallback shows initials on sand. */
export function Avatar({
  className,
  size,
  ...props
}: ComponentProps<typeof AvatarPrimitive.Root> & VariantProps<typeof avatarVariants>) {
  return <AvatarPrimitive.Root data-slot="avatar" className={cn(avatarVariants({ size }), className)} {...props} />;
}

export function AvatarImage({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Image>) {
  return <AvatarPrimitive.Image data-slot="avatar-image" className={cn("aspect-square size-full object-cover", className)} {...props} />;
}

export function AvatarFallback({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn("flex size-full items-center justify-center bg-sand font-semibold text-ink", className)}
      {...props}
    />
  );
}

/** Overlapping stack of avatars, e.g. a cause's top donors. */
export function AvatarGroup({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="avatar-group" className={cn("flex items-center -space-x-2.5", className)} {...props} />;
}

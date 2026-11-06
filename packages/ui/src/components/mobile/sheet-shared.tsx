// Written for Varada: props and classes the mobile bottom sheets share.

/** Open state and placement, common to every mobile sheet (all built on ui/drawer, i.e. vaul). */
export interface MobileSheetBaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Where the sheet portals to (default `document.body`). Pass a phone frame (an element with layout
   * containment, e.g. `@container`) and the sheet, its overlay and its snap points fit that frame.
   */
  container?: HTMLElement | null;
  /**
   * Modal (default): overlay, focus trap, outside content inert. `false` leaves the page usable and
   * drops the overlay, e.g. for a sheet shown open in a gallery frame.
   */
  modal?: boolean;
}

/** Heights relative to the portal container instead of the viewport, when there is one. */
export const CONTAINED_SHEET =
  "max-h-[88%] data-[vaul-snap-points=true]:h-[96%] data-[vaul-snap-points=true]:max-h-[96%]";

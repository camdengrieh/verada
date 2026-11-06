// Adapted from 21st.dev @kuratlielia/sortable-data-table (id 35036), rebuilt on @tanstack/react-table v9.
"use client";

import {
  createColumnHelper,
  createSortedRowModel,
  metaHelper,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ColumnHelper,
  type Header,
  type RowData,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@verada/ui/lib/utils";

/** Breakpoints below which a column is hidden (Tailwind defaults: sm 640, md 768, lg 1024, xl 1280). */
export type DataTableBreakpoint = "sm" | "md" | "lg" | "xl";

export interface DataTableColumnMeta {
  /** Right-align with tabular mono figures (prices, percentages, amounts). */
  numeric?: boolean;
  /** Hide this column on screens narrower than the breakpoint. */
  hideBelow?: DataTableBreakpoint;
  /** Shorthand for `hideBelow`: 1 always shows, 2 from sm, 3 from md, 4 from lg, 5 from xl. */
  priority?: 1 | 2 | 3 | 4 | 5;
  /** Keep this column stuck to the left edge while the table scrolls sideways (use on the first column). */
  pinned?: boolean;
  /** Plain-text column name for the sort button label and announcements when `header` is not a string. */
  label?: string;
  headerClassName?: string;
  cellClassName?: string;
}

/**
 * The feature set every DataTable uses: client sorting, row selection and typed column meta. Build
 * columns with `dataTableColumns<Row>()` so accessor value types and `meta` are checked.
 */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  rowSelectionFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic, datetime: sortFn_datetime, text: sortFn_text },
  columnMeta: metaHelper<DataTableColumnMeta>(),
});

export type DataTableFeatures = typeof dataTableFeatures;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous accessor value types
export type DataTableColumnDef<TData extends RowData> = ColumnDef<DataTableFeatures, TData, any>;

/** Column helper bound to the DataTable feature set. */
export function dataTableColumns<TData extends RowData>(): ColumnHelper<DataTableFeatures, TData> {
  return createColumnHelper<DataTableFeatures, TData>();
}

const HIDE_BELOW: Record<DataTableBreakpoint, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
};
const PRIORITY: Record<number, DataTableBreakpoint | undefined> = { 1: undefined, 2: "sm", 3: "md", 4: "lg", 5: "xl" };

function responsiveClass(meta: DataTableColumnMeta | undefined): string | undefined {
  const bp = meta?.hideBelow ?? (meta?.priority ? PRIORITY[meta.priority] : undefined);
  return bp ? HIDE_BELOW[bp] : undefined;
}

export interface DataTableProps<TData extends RowData> {
  columns: DataTableColumnDef<TData>[];
  data: TData[];
  /** Stable id per row (token address, tx hash…). Drives selection, flashing and row keys. */
  getRowId: (row: TData) => string;
  /** Names a row for its checkbox ("Select Harambe"). Defaults to the row id. */
  getRowLabel?: (row: TData) => string;
  /** Names the table for assistive tech; also labels the scroll region. */
  caption: string;
  /** Show the caption visually (it is always available to screen readers). */
  showCaption?: boolean;
  initialSorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  /** Allow a third click to clear the sort. Off by default: trading tables always have an order. */
  enableSortingRemoval?: boolean;
  /** Adds a checkbox column and a selected-count line. */
  selectable?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (selection: RowSelectionState) => void;
  /** Shows skeleton rows and marks the table busy. */
  loading?: boolean;
  skeletonRows?: number;
  /** Shown in place of rows when `data` is empty (an EmptyState works well). */
  empty?: ReactNode;
  /** Briefly tint rows whose ids were not in the previous `data` (live feeds). */
  flashNewRows?: boolean;
  /** Max height of the scroll box; the header stays stuck while rows scroll. */
  maxHeight?: string;
  density?: "comfortable" | "compact";
  /** Noun for the selection line, e.g. { one: "coin", other: "coins" }. */
  itemName?: { one: string; other: string };
  className?: string;
}

function columnLabel<TData extends RowData>(header: Header<DataTableFeatures, TData, unknown>): string {
  const def = header.column.columnDef;
  if (def.meta?.label) return def.meta.label;
  if (typeof def.header === "string") return def.header;
  return header.column.id;
}

/**
 * Sortable, accessible data table. Real `<table>` semantics with `aria-sort` on sortable headers,
 * a sticky header inside a keyboard-scrollable box, columns that drop away on narrow screens, an
 * optional checkbox column, skeleton and empty states, and a sage flash for rows that just arrived.
 */
export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  getRowLabel,
  caption,
  showCaption = false,
  initialSorting = [],
  onSortingChange,
  enableSortingRemoval = false,
  selectable = false,
  rowSelection: controlledSelection,
  onRowSelectionChange,
  loading = false,
  skeletonRows = 6,
  empty,
  flashNewRows = true,
  maxHeight,
  density = "comfortable",
  itemName = { one: "row", other: "rows" },
  className,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [internalSelection, setInternalSelection] = useState<RowSelectionState>({});
  const rowSelection = controlledSelection ?? internalSelection;
  const [announcement, setAnnouncement] = useState("");

  const allColumns = useMemo<DataTableColumnDef<TData>[]>(() => {
    if (!selectable) return columns;
    const helper = createColumnHelper<DataTableFeatures, TData>();
    const select = helper.display({
      id: "__select",
      enableSorting: false,
      header: ({ table }) => (
        <SelectBox
          label="Select all rows"
          checked={table.getIsAllRowsSelected()}
          indeterminate={table.getIsSomeRowsSelected()}
          onChange={table.getToggleAllRowsSelectedHandler()}
        />
      ),
      cell: ({ row }) => (
        <SelectBox
          label={`Select ${getRowLabel ? getRowLabel(row.original) : `row ${row.id}`}`}
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onChange={row.getToggleSelectedHandler()}
        />
      ),
    });
    return [select, ...columns];
  }, [columns, selectable, getRowLabel]);

  const table = useTable({
    features: dataTableFeatures,
    columns: allColumns,
    data,
    getRowId: (row) => getRowId(row),
    enableSortingRemoval,
    enableRowSelection: selectable,
    state: { sorting, rowSelection },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      setSorting(next);
      onSortingChange?.(next);
      const first = next[0];
      const header = first ? table.getFlatHeaders().find((h) => h.column.id === first.id) : undefined;
      setAnnouncement(
        first && header ? `Sorted by ${columnLabel(header)}, ${first.desc ? "descending" : "ascending"}` : "Sort cleared",
      );
    },
    onRowSelectionChange: (updater) => {
      const next = typeof updater === "function" ? updater(rowSelection) : updater;
      if (controlledSelection === undefined) setInternalSelection(next);
      onRowSelectionChange?.(next);
    },
  });

  // Rows that were not in the previous data flash once (skipped on first render).
  const seen = useRef<Set<string> | null>(null);
  const [flashing, setFlashing] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const ids = new Set(data.map(getRowId));
    const previous = seen.current;
    seen.current = ids;
    if (!previous || !flashNewRows) return;
    const fresh = new Set([...ids].filter((id) => !previous.has(id)));
    if (fresh.size === 0) return;
    setFlashing(fresh);
    const timer = setTimeout(() => setFlashing(new Set()), 1300);
    return () => clearTimeout(timer);
  }, [data, getRowId, flashNewRows]);

  const rows = table.getRowModel().rows;
  const headerGroups = table.getHeaderGroups();
  const columnCount = allColumns.length;
  const selectedCount = selectable ? Object.values(rowSelection).filter(Boolean).length : 0;
  const cellPad = density === "compact" ? "px-3 py-2" : "px-4 py-3";

  return (
    <div data-slot="data-table" className={cn("flex flex-col gap-2", className)}>
      <div
        role="region"
        aria-label={caption}
        tabIndex={0}
        className="relative overflow-auto rounded-2xl border border-line bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        style={maxHeight ? { maxHeight } : undefined}
      >
        <table aria-busy={loading || undefined} className="w-full border-separate border-spacing-0 text-left text-[15px]">
          <caption className={cn(showCaption ? "caption-top px-4 pt-3 pb-1 text-left kicker" : "sr-only")}>{caption}</caption>
          <thead>
            {headerGroups.map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const meta = header.column.columnDef.meta;
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const isSelect = header.column.id === "__select";
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={canSort ? (sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none") : undefined}
                      className={cn(
                        "sticky top-0 z-10 border-b border-line bg-card text-[13px] font-semibold whitespace-nowrap text-ink-muted",
                        isSelect ? "w-12 px-1" : canSort ? "px-1.5 py-1" : cellPad,
                        meta?.numeric && "text-right",
                        meta?.pinned && "left-0 z-20",
                        responsiveClass(meta),
                        meta?.headerClassName,
                      )}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "inline-flex min-h-11 items-center gap-1.5 rounded-full px-2.5 hover:bg-sand hover:text-ink",
                            sorted && "text-ink",
                            meta?.numeric && "flex-row-reverse",
                          )}
                        >
                          <table.FlexRender header={header} />
                          <SortGlyph sorted={sorted} />
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: skeletonRows }, (_, i) => (
                <tr key={`skeleton-${i}`} aria-hidden="true">
                  {table.getFlatHeaders().map((header) => (
                    <td
                      key={header.id}
                      className={cn("border-b border-line", cellPad, responsiveClass(header.column.columnDef.meta))}
                    >
                      <span
                        className={cn(
                          "block h-4 animate-pulse rounded-full bg-sand",
                          header.column.columnDef.meta?.numeric ? "ml-auto w-16" : i % 2 ? "w-28" : "w-36",
                        )}
                      />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="px-4 py-10 text-center text-muted-foreground">
                  {empty ?? "Nothing to show yet."}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const selected = selectable && row.getIsSelected();
                return (
                  <tr
                    key={row.id}
                    data-state={selected ? "selected" : undefined}
                    data-new={flashing.has(row.id) || undefined}
                    className={cn(
                      "group/row transition-colors hover:bg-sand/50 data-[state=selected]:bg-sage-tint/60",
                      flashing.has(row.id) && "animate-flash",
                    )}
                  >
                    {row.getAllCells().map((cell) => {
                      const meta = cell.column.columnDef.meta;
                      const isSelect = cell.column.id === "__select";
                      return (
                        <td
                          key={cell.id}
                          className={cn(
                            "border-b border-line align-middle group-last/row:border-b-0",
                            isSelect ? "w-12 px-1" : cellPad,
                            meta?.numeric && "num text-right whitespace-nowrap",
                            meta?.pinned && "sticky left-0 z-[1] bg-card group-hover/row:bg-sand group-data-[state=selected]/row:bg-sage-tint",
                            responsiveClass(meta),
                            meta?.cellClassName,
                          )}
                        >
                          <table.FlexRender cell={cell} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {selectable ? (
        <div className="flex min-h-11 items-center gap-3 px-1 text-sm text-ink-soft">
          <span className="num">{selectedCount || data.length}</span>
          <span>{selectedCount ? "selected" : data.length === 1 ? itemName.one : itemName.other}</span>
          {selectedCount ? (
            <button
              type="button"
              onClick={() => table.resetRowSelection(true)}
              className="ml-auto inline-flex min-h-11 items-center rounded-full px-4 font-semibold text-primary hover:bg-sand"
            >
              Clear selection
            </button>
          ) : null}
        </div>
      ) : null}
      <p role="status" className="sr-only">
        {loading ? "Loading" : announcement}
      </p>
    </div>
  );
}

function SortGlyph({ sorted }: { sorted: false | "asc" | "desc" }) {
  const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ChevronsUpDown;
  return <Icon aria-hidden="true" className={cn("size-3.5", !sorted && "opacity-50")} />;
}

function SelectBox({
  label,
  checked,
  indeterminate = false,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (event: unknown) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <label className="flex size-11 cursor-pointer items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="size-[18px] cursor-pointer rounded accent-sage"
      />
    </label>
  );
}

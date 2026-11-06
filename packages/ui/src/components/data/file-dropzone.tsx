// Adapted from 21st.dev @joyco/file-dropzone (id 19201); its useFileUpload helper rewritten inline (single image, typed errors).
"use client";

import { AlertCircle, ImageUp, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { Button } from "@verada/ui/components/ui/button";
import { cn } from "@verada/ui/lib/utils";

const TYPE_NAMES: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
  "image/svg+xml": "SVG",
  "image/avif": "AVIF",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / 1024 / 1024;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

function typeName(mime: string, filename?: string): string {
  return TYPE_NAMES[mime] ?? (mime ? mime.split("/").pop()!.toUpperCase() : (filename?.split(".").pop()?.toUpperCase() ?? "unknown"));
}

/** Does `file` match an `accept` list ("image/png,image/*,.webp")? */
export function fileMatchesAccept(file: File, accept: string): boolean {
  const rules = accept
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  if (rules.length === 0) return true;
  const mime = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return rules.some((rule) =>
    rule.startsWith(".") ? name.endsWith(rule) : rule.endsWith("/*") ? mime.startsWith(rule.slice(0, -1)) : mime === rule,
  );
}

/** Human list of accepted types: "PNG, JPEG or WebP". */
export function describeAccept(accept: string): string {
  const names = accept
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => (r.startsWith(".") ? r.slice(1).toUpperCase() : r.endsWith("/*") ? `any ${r.slice(0, -2)}` : typeName(r)));
  if (names.length <= 1) return names[0] ?? "any file";
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** Returns an error message, or null when the file is acceptable. */
export function validateFile(file: File, accept: string, maxSize: number): string | null {
  if (!fileMatchesAccept(file, accept)) {
    return `${describeAccept(accept)} only. That file is ${/^[aeiou]/i.test(typeName(file.type, file.name)) ? "an" : "a"} ${typeName(file.type, file.name)}.`;
  }
  if (file.size > maxSize) return `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(maxSize)}.`;
  return null;
}

export interface FileDropzoneProps {
  /** Visible label, e.g. "Coin logo". */
  label: string;
  /** Comma-separated MIME types or extensions. Defaults to coin logos: PNG, JPEG, WebP. */
  accept?: string;
  /** Bytes. Defaults to 2 MB. */
  maxSize?: number;
  /** Controlled file. */
  value?: File | null;
  onChange?: (file: File | null) => void;
  /** Extra hint under the label (dimensions, square crop…). */
  hint?: string;
  /** External error (e.g. from the form) shown with the local ones. */
  error?: string;
  disabled?: boolean;
  name?: string;
  className?: string;
}

/**
 * Image drop zone with preview, for coin logos and cause art. Drop or choose a file; type and
 * size are checked before anything is kept, and problems are announced (`role="alert"`). The real
 * file input is visually hidden and takes keyboard focus (Space or Enter opens the picker); the Choose and Replace buttons are
 * pointer shortcuts to it.
 */
export function FileDropzone({
  label,
  accept = "image/png,image/jpeg,image/webp",
  maxSize = 2 * 1024 * 1024,
  value,
  onChange,
  hint,
  error,
  disabled = false,
  name,
  className,
}: FileDropzoneProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [internal, setInternal] = useState<File | null>(null);
  const file = value === undefined ? internal : value;
  const [localError, setLocalError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  // Object URLs are created and revoked in an effect so StrictMode never leaks one.
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const commit = (next: File | null) => {
    if (value === undefined) setInternal(next);
    onChange?.(next);
  };

  const take = (candidate: File | undefined) => {
    if (!candidate) return;
    const problem = validateFile(candidate, accept, maxSize);
    setLocalError(problem);
    if (!problem) commit(candidate);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (disabled) return;
    take(e.dataTransfer?.files?.[0]);
  };

  const shownError = localError ?? error ?? null;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const limits = `${describeAccept(accept)}, up to ${formatBytes(maxSize)}.`;

  return (
    <div data-slot="file-dropzone" className={cn("flex flex-col gap-2", className)}>
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      <div
        data-dragging={dragging || undefined}
        data-invalid={shownError ? true : undefined}
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current += 1;
          if (!disabled) setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        }}
        onDrop={onDrop}
        className={cn(
          "relative flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-line-strong bg-paper-card p-5 text-center transition-colors",
          "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring",
          "data-[dragging]:border-sage data-[dragging]:bg-sage-tint",
          "data-[invalid]:border-destructive",
          disabled && "opacity-60",
        )}
      >
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="file"
          accept={accept}
          disabled={disabled}
          aria-describedby={shownError ? `${hintId} ${errorId}` : hintId}
          aria-invalid={shownError ? true : undefined}
          className="sr-only"
          onChange={(e) => {
            take(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {file ? (
          <div className="flex w-full flex-col items-center gap-3 sm:flex-row sm:text-left">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element -- local blob preview, nothing to optimise
              <img src={preview} alt={`Preview of ${file.name}`} className="size-24 shrink-0 rounded-2xl border border-line bg-sand object-cover" />
            ) : (
              <div aria-hidden="true" className="flex size-24 shrink-0 items-center justify-center rounded-2xl border border-line bg-sand">
                <ImageUp className="size-6 text-ink-muted" />
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-medium text-ink">{file.name}</span>
              <span className="num text-sm text-ink-muted">
                {typeName(file.type, file.name)} · {formatBytes(file.size)}
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="soft" size="md" tabIndex={-1} aria-hidden="true" disabled={disabled} onClick={() => inputRef.current?.click()}>
                <RefreshCw aria-hidden="true" />
                Replace
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${file.name}`}
                disabled={disabled}
                onClick={() => {
                  setLocalError(null);
                  commit(null);
                }}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : (
          <>
            <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-sand text-ink-soft">
              <ImageUp className="size-5" />
            </span>
            <p className="font-medium text-ink">Drop an image here</p>
            <Button variant="outline" tabIndex={-1} aria-hidden="true" disabled={disabled} onClick={() => inputRef.current?.click()}>
              Choose image
            </Button>
          </>
        )}
      </div>
      <p id={hintId} className="text-sm text-ink-muted">
        {hint ? `${hint} ` : ""}
        {limits}
      </p>
      {shownError ? (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {shownError}
        </p>
      ) : null}
    </div>
  );
}

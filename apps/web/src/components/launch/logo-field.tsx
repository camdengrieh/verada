"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@varada/ui/components/data/file-dropzone";
import { useAppConfig } from "@/components/providers";
import { checkLogoFile, PublisherClient, type LogoUpload } from "@/lib/publisher";

type UploadState = { status: "idle" } | { status: "uploading"; size: number } | { status: "done"; upload: LogoUpload } | { status: "error"; message: string };

/**
 * Logo drop zone that uploads to the publisher as soon as a file is kept. The preview is a local
 * object URL, so nothing is fetched from a gateway before the upload succeeds.
 */
export function LogoField({ onUploaded, onUploading, error }: { onUploaded(upload: LogoUpload | null): void; onUploading(busy: boolean): void; error?: string }) {
  const config = useAppConfig();
  const publisher = useMemo(() => (config.publisherUrl ? new PublisherClient(config.publisherUrl) : null), [config.publisherUrl]);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>({ status: "idle" });

  async function onChange(next: File | null) {
    setFile(next);
    onUploaded(null);
    if (!next) {
      onUploading(false);
      return setState({ status: "idle" });
    }
    if (!publisher) return setState({ status: "error", message: "The publisher is not configured (publisherUrl in config.json), so logos cannot be uploaded." });
    const invalid = checkLogoFile(next);
    if (invalid) return setState({ status: "error", message: invalid });
    setState({ status: "uploading", size: next.size });
    onUploading(true);
    try {
      const upload = await publisher.uploadLogo(next, next.name || "logo");
      setState({ status: "done", upload });
      onUploaded(upload);
    } catch (e) {
      setState({ status: "error", message: e instanceof Error ? e.message : "Upload failed" });
    } finally {
      onUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <FileDropzone
        label="Logo"
        hint="Square works best. The image is stored on Swarm and becomes the coin's logo."
        value={file}
        onChange={(f) => void onChange(f)}
        error={state.status === "error" ? state.message : error}
      />
      {state.status === "uploading" ? (
        <p role="status" className="m-0 text-sm text-ink-soft">
          Uploading {Math.ceil(state.size / 1024)} KiB to Swarm
        </p>
      ) : null}
      {state.status === "done" ? (
        <p role="status" className="m-0 break-all text-sm text-sage-ink">
          Stored on Swarm: <code className="font-mono text-xs">{state.upload.reference}</code>
        </p>
      ) : null}
    </div>
  );
}

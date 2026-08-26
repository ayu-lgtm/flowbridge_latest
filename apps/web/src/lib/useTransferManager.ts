import { useCallback, useEffect, useRef, useState } from "react";
import {
  LoopGuard,
  TransferReceiver,
  TransferSender,
  buildAckMissing,
  type FlowMessage,
} from "@flowbridge/protocol";
import type { FlowConnection } from "@flowbridge/protocol";

export interface ReceivedFile {
  transferId: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
  receivedAt: number;
}

export interface ActiveTransfer {
  transferId: string;
  kind: "text" | "file";
  direction: "sending" | "receiving";
  label: string;
  receivedChunks: number;
  totalChunks: number;
  startedAt: number;
  status: "in-progress" | "done" | "error";
}

export function useTransferManager(
  connection: FlowConnection | null,
  deviceId: string,
  onClipboardTextReceived: (text: string) => void
) {
  const receiverRef = useRef(new TransferReceiver());
  const senderRef = useRef(new TransferSender());
  const loopGuardRef = useRef(new LoopGuard());
  const [lastReceivedChars, setLastReceivedChars] = useState<number | null>(null);
  const [lastReceivedText, setLastReceivedText] = useState<string | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [activeTransfers, setActiveTransfers] = useState<Record<string, ActiveTransfer>>({});

  useEffect(() => {
    const receiver = receiverRef.current;

    receiver.onProgress = (transferId, kind, received, total) => {
      setActiveTransfers((prev) => ({
        ...prev,
        [transferId]: {
          transferId,
          kind,
          direction: "receiving",
          label: prev[transferId]?.label ?? (kind === "text" ? "Clipboard text" : "File"),
          receivedChunks: received,
          totalChunks: total,
          startedAt: prev[transferId]?.startedAt ?? Date.now(),
          status: "in-progress",
        },
      }));
    };

    receiver.onTextComplete = (text, meta) => {
      loopGuardRef.current.registerIncoming(meta.transferId);
      setLastReceivedChars(text.length);
      // Keep the actual text, not just its length: if the automatic
      // clipboard write fails (most commonly because the tab was
      // minimized/unfocused at that exact moment — see App.tsx's
      // retry-on-focus logic and the "Copy received text" fallback
      // button), this is the only remaining copy of what arrived. Without
      // this the data was silently gone the moment the write failed.
      setLastReceivedText(text);
      setActiveTransfers((prev) => ({
        ...prev,
        [meta.transferId]: { ...prev[meta.transferId], status: "done" } as ActiveTransfer,
      }));
      onClipboardTextReceived(text);
    };

    receiver.onFileComplete = (bytes, meta) => {
      const blob = new Blob([bytes.slice().buffer], { type: meta.mimeType || "application/octet-stream" });
      setReceivedFiles((prev) => [
        { transferId: meta.transferId, fileName: meta.fileName, mimeType: meta.mimeType, blob, receivedAt: Date.now() },
        ...prev,
      ]);
      setActiveTransfers((prev) => ({
        ...prev,
        [meta.transferId]: { ...prev[meta.transferId], status: "done" } as ActiveTransfer,
      }));
    };

    receiver.onIntegrityFailure = (transferId) => {
      setActiveTransfers((prev) => ({
        ...prev,
        [transferId]: { ...prev[transferId], status: "error" } as ActiveTransfer,
      }));
    };

    // A transfer that arrived incomplete (chunks dropped mid-transfer, most
    // often during a reconnect) now actively asks the sender to resend
    // exactly what's missing, instead of silently hanging forever.
    receiver.onRequestMissing = (transferId, kind, missingIndices) => {
      if (!connection) return;
      connection.send(buildAckMissing(transferId, kind, missingIndices, deviceId));
    };

    receiver.onTransferStalled = (transferId) => {
      setActiveTransfers((prev) => ({
        ...prev,
        [transferId]: { ...prev[transferId], status: "error" } as ActiveTransfer,
      }));
    };
  }, [onClipboardTextReceived, connection, deviceId]);

  const handleIncoming = useCallback((msg: FlowMessage) => {
    receiverRef.current.handle(msg);
    if (connection) senderRef.current.handleIncoming(msg, (m) => connection.send(m));
  }, [connection]);

  const sendText = useCallback(
    async (text: string) => {
      if (!connection) return;
      const transferId = crypto.randomUUID();
      setActiveTransfers((prev) => ({
        ...prev,
        [transferId]: {
          transferId,
          kind: "text",
          direction: "sending",
          label: "Clipboard text",
          receivedChunks: 0,
          totalChunks: 1,
          startedAt: Date.now(),
          status: "in-progress",
        },
      }));
      await senderRef.current.sendText(text, deviceId, (m) => connection.send(m));
      setActiveTransfers((prev) => ({
        ...prev,
        [transferId]: { ...prev[transferId], status: "done" } as ActiveTransfer,
      }));
    },
    [connection, deviceId]
  );

  const sendFile = useCallback(
    async (file: File) => {
      if (!connection) return;
      const transferId = crypto.randomUUID();
      setActiveTransfers((prev) => ({
        ...prev,
        [transferId]: {
          transferId,
          kind: "file",
          direction: "sending",
          label: file.name,
          receivedChunks: 0,
          totalChunks: 1,
          startedAt: Date.now(),
          status: "in-progress",
        },
      }));
      await senderRef.current.sendFile(file, deviceId, (m) => connection.send(m), undefined, (sent, total) => {
        setActiveTransfers((prev) => ({
          ...prev,
          [transferId]: {
            ...prev[transferId],
            receivedChunks: sent,
            totalChunks: total,
          } as ActiveTransfer,
        }));
      });
      setActiveTransfers((prev) => ({
        ...prev,
        [transferId]: { ...prev[transferId], status: "done" } as ActiveTransfer,
      }));
    },
    [connection, deviceId]
  );

  return {
    handleIncoming,
    sendText,
    sendFile,
    lastReceivedChars,
    lastReceivedText,
    receivedFiles,
    activeTransfers,
    loopGuard: loopGuardRef.current,
  };
}

/**
 * FlowBridge wire protocol.
 *
 * Every message that crosses a DataChannel or the relay WebSocket is one of
 * these JSON-serializable envelopes. Binary chunk payloads are sent as a
 * base64 string inside the envelope so the whole thing stays JSON — this
 * keeps the relay server format-agnostic (it never has to parse binary
 * frames, so it never needs to understand or store content).
 *
 * Loop prevention: every content-bearing message carries `originId`
 * (the device that first created the content) and a `contentHash`. A
 * receiving device that just wrote something to its own clipboard remembers
 * (originId, contentHash) for a short window and will not re-broadcast an
 * identical clipboard-change event it detects immediately afterward. See
 * `LoopGuard` in loop-guard.ts.
 */
export type DeviceRole = "phone" | "laptop";
export interface DeviceInfo {
    deviceId: string;
    role: DeviceRole;
    label: string;
}
export type MessageType = "pair:hello" | "pair:code" | "pair:ok" | "pair:error" | "pair:resume" | "pair:resumed" | "pair:resume-waiting" | "pair:resume-failed" | "ping" | "pong" | "clipboard:update" | "text:start" | "text:chunk" | "text:end" | "text:ack-missing" | "file:offer" | "file:accept" | "file:decline" | "file:start" | "file:chunk" | "file:end" | "file:ack-missing" | "file:progress" | "transfer:cancel" | "transfer:error" | "signal:offer" | "signal:answer" | "signal:ice" | "peer:joined" | "peer:left";
export interface BaseMessage {
    type: MessageType;
    messageId: string;
    originId: string;
    ts: number;
}
/** Small text/code payloads that fit in one chunk (kept for symmetry/logging). */
export interface ClipboardUpdateMessage extends BaseMessage {
    type: "clipboard:update";
    transferId: string;
    contentHash: string;
    totalLength: number;
    encoding: "utf-8";
}
export interface TextStartMessage extends BaseMessage {
    type: "text:start";
    transferId: string;
    contentHash: string;
    totalLength: number;
    chunkCount: number;
    chunkSizeBytes: number;
    encoding: "utf-8";
    newline: "auto";
}
export interface TextChunkMessage extends BaseMessage {
    type: "text:chunk";
    transferId: string;
    index: number;
    data: string;
}
export interface TextEndMessage extends BaseMessage {
    type: "text:end";
    transferId: string;
}
export interface AckMissingMessage extends BaseMessage {
    type: "text:ack-missing" | "file:ack-missing";
    transferId: string;
    missingIndices: number[];
}
export interface FileOfferMessage extends BaseMessage {
    type: "file:offer";
    transferId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    contentHash: string;
}
export interface FileAcceptMessage extends BaseMessage {
    type: "file:accept";
    transferId: string;
}
export interface FileDeclineMessage extends BaseMessage {
    type: "file:decline";
    transferId: string;
    reason?: string;
}
export interface FileStartMessage extends BaseMessage {
    type: "file:start";
    transferId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    contentHash: string;
    chunkCount: number;
    chunkSizeBytes: number;
}
export interface FileChunkMessage extends BaseMessage {
    type: "file:chunk";
    transferId: string;
    index: number;
    data: string;
}
export interface FileEndMessage extends BaseMessage {
    type: "file:end";
    transferId: string;
}
export interface FileProgressMessage extends BaseMessage {
    type: "file:progress";
    transferId: string;
    receivedChunks: number;
    totalChunks: number;
    bytesReceived: number;
    totalBytes: number;
}
export interface TransferCancelMessage extends BaseMessage {
    type: "transfer:cancel";
    transferId: string;
    reason?: string;
}
export interface TransferErrorMessage extends BaseMessage {
    type: "transfer:error";
    transferId: string;
    reason: string;
}
export interface PingMessage extends BaseMessage {
    type: "ping";
}
export interface PongMessage extends BaseMessage {
    type: "pong";
}
export interface PairHelloMessage extends BaseMessage {
    type: "pair:hello";
    code: string;
    device: DeviceInfo;
}
export interface PairCodeMessage extends BaseMessage {
    type: "pair:code";
    code: string;
    expiresInMs: number;
}
export interface PairOkMessage extends BaseMessage {
    type: "pair:ok";
    sessionId: string;
    peer: DeviceInfo;
}
export interface PairErrorMessage extends BaseMessage {
    type: "pair:error";
    reason: string;
}
/**
 * Sent by a device that has ALREADY completed pairing once and just
 * reconnected its signaling socket — network blip, laptop woke from sleep,
 * phone screen came back on, browser/tab was fully closed and reopened
 * hours later, or the relay server itself restarted. `sessionId` here is
 * the permanent pairing code from the original "pair:ok" — both devices
 * remember it locally forever (see localStorage on the web app / phone),
 * so pairing is a one-time action, not a recurring one.
 *
 * This never "fails" in a way that forces a new QR scan: if the server
 * still has the room, it reattaches instantly ("pair:resumed"); if the
 * server has forgotten it (e.g. a restart), it quietly recreates an empty
 * room under the same code and waits ("pair:resume-waiting") for the peer
 * — which will arrive on its own the moment ITS client also retries the
 * same saved code, with no user action on either side.
 */
export interface PairResumeMessage extends BaseMessage {
    type: "pair:resume";
    sessionId: string;
    device: DeviceInfo;
}
export interface PairResumedMessage extends BaseMessage {
    type: "pair:resumed";
    sessionId: string;
    peer: DeviceInfo;
}
/** Server has (re)created the room but the peer hasn't reconnected yet. Keep waiting/retrying — do not clear the saved pairing. */
export interface PairResumeWaitingMessage extends BaseMessage {
    type: "pair:resume-waiting";
    sessionId: string;
}
/** Reserved for a genuinely malformed resume request. Not used in normal operation — see PairResumeWaitingMessage. */
export interface PairResumeFailedMessage extends BaseMessage {
    type: "pair:resume-failed";
    reason: string;
}
export interface SignalOfferMessage extends BaseMessage {
    type: "signal:offer";
    sessionId: string;
    sdp: string;
}
export interface SignalAnswerMessage extends BaseMessage {
    type: "signal:answer";
    sessionId: string;
    sdp: string;
}
export interface SignalIceMessage extends BaseMessage {
    type: "signal:ice";
    sessionId: string;
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
}
export interface PeerJoinedMessage extends BaseMessage {
    type: "peer:joined";
    sessionId: string;
    peer: DeviceInfo;
}
export interface PeerLeftMessage extends BaseMessage {
    type: "peer:left";
    sessionId: string;
}
export type FlowMessage = ClipboardUpdateMessage | TextStartMessage | TextChunkMessage | TextEndMessage | AckMissingMessage | FileOfferMessage | FileAcceptMessage | FileDeclineMessage | FileStartMessage | FileChunkMessage | FileEndMessage | FileProgressMessage | TransferCancelMessage | TransferErrorMessage | PingMessage | PongMessage | PairHelloMessage | PairCodeMessage | PairOkMessage | PairErrorMessage | PairResumeMessage | PairResumedMessage | PairResumeWaitingMessage | PairResumeFailedMessage | SignalOfferMessage | SignalAnswerMessage | SignalIceMessage | PeerJoinedMessage | PeerLeftMessage;

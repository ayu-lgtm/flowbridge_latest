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
export {};

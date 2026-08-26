# Testing

## Verified during development (automated)

An end-to-end smoke test (pairing over the real server + chunked transfer +
checksum verification) was run against the built server and protocol
package:

- Paired two simulated WebSocket clients through the real pairing flow
  (`pair:hello` → code issuance → `pair:hello` with code → `pair:ok`).
- Sent a **50,000-line** text payload containing a mix of tab
  indentation, Windows CRLF line endings, and multi-byte Unicode
  (accented Latin, CJK, emoji) through `sendText` → chunked over the relay
  → reassembled by `TransferReceiver`.
- Result: reassembled text was **byte-for-byte identical** to the
  original (`receivedText === sentText`), and the SHA-256 hash of the
  reassembled bytes matched the hash computed before sending.

This exercises: pairing, chunking, base64 round-trip, out-of-order-safe
reassembly logic, UTF-8 preservation, and checksum verification together.

## Recommended additional test matrix

The protocol and transfer code is written to make all of these
straightforward to add as automated tests (Vitest/Jest against
`packages/protocol`, since chunking/checksums/loop-guard are pure
TypeScript with no browser-only APIs except `crypto.subtle`, which Node 20+
provides natively):

| # | Case | How to test |
|---|------|-------------|
| 1 | 100-line text | `sendText`/`TransferReceiver` round-trip, assert equality |
| 2 | 10,000-line text | same, larger fixture |
| 3 | 50,000-line text | same — already verified manually, see above |
| 4 | Unicode text | fixture with combining marks, emoji, CJK, RTL text |
| 5 | Windows CRLF | fixture with `\r\n` throughout, assert no normalization |
| 6 | Unix LF | fixture with `\n` throughout |
| 7 | Tabs and spaces | fixture mixing both, assert exact indentation preserved |
| 8 | Large JSON | minified + pretty-printed large JSON fixture |
| 9 | Large JavaScript file | real-world large `.js`/`.ts` file as fixture |
| 10 | Binary files | `sendFile`/`TransferReceiver` with a `.png`/`.zip` fixture, compare bytes |
| 11 | Interrupted transfer | call `receiver.handle()` with some `*:chunk` messages withheld; assert `isComplete()` is false and `missingIndices()` lists them |
| 12 | Duplicate chunks | feed the same `*:chunk` message twice; assert result is unaffected (idempotent `addChunk`) |
| 13 | Checksum failure | mutate one chunk's `data` before the final `*:end`; assert `onIntegrityFailure` fires instead of silently accepting corrupted output |
| 14 | Reconnect | close the WebSocket mid-test and reopen; assert `FlowConnection`'s exponential-backoff reconnect resumes relay transport |
| 15 | Clipboard loop prevention | feed a `contentHash` into `LoopGuard.registerIncoming`, then assert `shouldSuppress` returns true within the TTL window and false after it expires |

To wire these up as a real test suite:

```bash
npm install -D vitest --workspace=packages/protocol
# add "test": "vitest run" to packages/protocol/package.json
```

Then create `packages/protocol/src/*.test.ts` files exercising the table
above directly against the exported `sendText`, `TransferReceiver`,
`ChunkAssembler`, `LoopGuard`, and `sha256Hex` functions — none of them
need a browser, a real WebSocket, or a real WebRTC connection to unit-test,
which keeps this fast and CI-friendly. The pairing/signaling/relay path
(as exercised manually above) is better suited to an integration test that
spins up `apps/server` in-process, which is the pattern the manual smoke
test above already follows.

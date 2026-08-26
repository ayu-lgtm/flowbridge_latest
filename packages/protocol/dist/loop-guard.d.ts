/**
 * Prevents clipboard sync loops (Phone -> Laptop -> Phone -> ...).
 *
 * Whenever a device WRITES content to its own OS/browser clipboard because
 * it arrived from the peer, it registers (contentHash) here BEFORE writing.
 * The device's own clipboard-change watcher fires immediately afterward
 * (because the write itself is a change); before broadcasting that change
 * back out, it checks `shouldSuppress`. If the hash matches a recent
 * remote-origin write, the local echo is suppressed instead of re-sent.
 *
 * Entries expire after `ttlMs` so that genuinely re-copying the same text
 * later (a legitimate user action) is not permanently blocked.
 */
export declare class LoopGuard {
    private recent;
    private ttlMs;
    constructor(ttlMs?: number);
    registerIncoming(contentHash: string): void;
    shouldSuppress(contentHash: string): boolean;
    private sweep;
}

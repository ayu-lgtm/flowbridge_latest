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
export class LoopGuard {
    constructor(ttlMs = 4000) {
        this.recent = new Map(); // contentHash -> expiry epoch ms
        this.ttlMs = ttlMs;
    }
    registerIncoming(contentHash) {
        this.recent.set(contentHash, Date.now() + this.ttlMs);
        this.sweep();
    }
    shouldSuppress(contentHash) {
        this.sweep();
        const expiry = this.recent.get(contentHash);
        if (expiry === undefined)
            return false;
        return Date.now() < expiry;
    }
    sweep() {
        const now = Date.now();
        for (const [hash, expiry] of this.recent) {
            if (expiry <= now)
                this.recent.delete(hash);
        }
    }
}

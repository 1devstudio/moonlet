// Where the user is (X75): the phone tells each connected host when the
// user is active here, at most every 30 s per host, so the central host
// can open a sign-in on the phone.

import { ACTIVE_EVERY_MS, reportsActive } from "@desktop/lib/browserRoute";

export class Presence {
  /** When the user was last active on the phone. */
  private lastActive: number | null = null;
  /** When each host was last told. */
  private sent = new Map<string, number>();

  /** The user did something at `now`: which of the `connected` hosts to
   * tell. */
  active(now: number, connected: string[]): string[] {
    this.lastActive = now;
    const due = connected.filter((h) => reportsActive(this.sent.get(h) ?? null, now));
    for (const h of due) this.sent.set(h, now);
    return due;
  }

  /** Host `h` connected at `now`: whether to tell it, because the user was
   * active here within the last 30 s. */
  connected(h: string, now: number): boolean {
    if (this.lastActive === null || now - this.lastActive >= ACTIVE_EVERY_MS) return false;
    this.sent.set(h, now);
    return true;
  }

  /** Telling `h` failed: the next activity tells it again. */
  failed(h: string) {
    this.sent.delete(h);
  }
}

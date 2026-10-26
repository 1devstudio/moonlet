// A design's comments on the design screen (X65): the numbered pins over the
// page, the comment box pinned to an element, the Comments tab of the right
// rail, and a chat message of comments as Comment from the canvas cards.
// What they decide is in lib/designComments.ts.

import { ChevronDown, X } from "lucide-react";
import { useState } from "react";
import type { DesignComment } from "../../lib/protocol";
import type { Rect } from "../../lib/designBridge";
import { BOX_SIZE, COMMENT_PIN_ATTR, boxLabel, boxPlace, commentLine, pinPlace, commentsTab, footerLabel, pinLabel, sentLabel, type CommentRef, type PageMids } from "../../lib/designComments";
import { pageFile } from "../../lib/designPage";
import { cx } from "../../lib/cx";
import { Button } from "../ui";
import { Menu } from "../Menu";

/** A pin's number in its orange badge. */
export function PinBadge({ n, className }: { n: number | null; className?: string }) {
  return (
    <span className={cx("flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full rounded-bl-sm bg-accent px-1 font-mono ui-text-11 font-semibold text-bg", className)}>
      {n ?? "·"}
    </span>
  );
}

/** The open pins over the page of `size` px at `scale`: each at its
 *  element's top right corner, as the bridge last reported its box, clipped
 *  to the page; none for an element scrolled out of it (pinPlace). */
export function PinLayer({ pins, rects, scale, size, open, onOpen }: { pins: DesignComment[]; rects: Record<string, Rect>; scale: number; size: [number, number]; open: number | null; onOpen: (pin: DesignComment) => void }) {
  return (
    <div className="pointer-events-none absolute left-0 top-0 z-10 overflow-hidden" style={{ width: size[0], height: size[1] }}>
      {pins.map((p) => {
        const r = rects[p.mid];
        const place = r && pinPlace(r, scale, size);
        if (!place) return null;
        return (
          <button
            key={p.n}
            aria-label={`Comment ${p.n}`}
            title={p.comment}
            onClick={() => onOpen(p)}
            className={cx("pointer-events-auto absolute rounded-full shadow-md ring-2 ring-bg", open === p.n && "ring-fg")}
            style={place}
          >
            <PinBadge n={p.n} />
          </button>
        );
      })}
    </div>
  );
}

/** The element a comment box is about, and the pin it already is. */
export interface BoxTarget {
  element: { mid: string; tag: string; text: string };
  /** Its box in the page when it was picked. */
  rect: Rect;
  pin: DesignComment | null;
}




/** The comment box, pinned under its element (above it when there is no
 *  room below), inside the frame of `size` px. **Keep** saves it, **Send**
 *  (⌘↵) sends it to the chat. */
export function CommentBox({
  target,
  rect,
  scale,
  size,
  canSend,
  onKeep,
  onSend,
  onClose,
}: {
  target: BoxTarget;
  rect: Rect;
  scale: number;
  size: [number, number];
  canSend: boolean;
  onKeep: (comment: string) => void;
  onSend: (comment: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(target.pin?.comment ?? "");
  const ok = text.trim().length > 0;
  const { left, top } = boxPlace(rect, scale, size);
  return (
    <div
      role="dialog"
      aria-label="Comment"
      className="absolute z-20 flex flex-col overflow-hidden rounded-lg border border-border-strong bg-panel shadow-2xl"
      style={{ left, top, width: BOX_SIZE.w }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.key === "Enter" && e.metaKey) {
          e.preventDefault();
          if (ok && canSend) onSend(text);
        }
      }}
    >
      <div className="flex h-9 items-center gap-2 border-b border-border px-2.5">
        {target.pin && <PinBadge n={target.pin.n} />}
        <span className="min-w-0 flex-1 truncate font-mono ui-text-11.5 text-muted">{boxLabel(target.element)}</span>
        <button aria-label="Close" className="text-faint hover:text-fg" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <textarea
        autoFocus
        aria-label="Comment"
        placeholder="What should change here?"
        className="h-20 resize-none bg-transparent px-3 py-2 ui-text-13 text-fg outline-none placeholder:text-faint"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-1.5 border-t border-border px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate ui-text-11.5 text-faint">⌘↵ sends to the chat</span>
        <Button size="sm" variant="ghost" disabled={!ok} onClick={() => onKeep(text)}>
          Keep
        </Button>
        <span title={canSend ? undefined : "The design's agent is not running"}>
          <Button size="sm" variant="primary" disabled={!ok || !canSend} onClick={() => onSend(text)}>
            Send
          </Button>
        </span>
      </div>
    </div>
  );
}

/** The right rail's Comments tab: Open and Resolved, a page filter, each pin
 *  sent or not with its actions, the orphaned pins, and Send all. */
export function CommentsTab({
  pins,
  mids,
  pages,
  sending,
  rail,
  onSend,
  onSendAll,
  onResolve,
  onShowInChat,
  onPick,
}: {
  pins: DesignComment[];
  mids: PageMids;
  pages: string[];
  /** The pins a Send is on its way with, whose Send is off meanwhile. */
  sending: number[];
  /** What its buttons may do (`commentsRail`). */
  rail: { send: boolean; resolve: boolean; why: string | null };
  onSend: (pin: DesignComment) => void;
  onSendAll: () => void;
  onResolve: (pin: DesignComment) => void;
  onShowInChat: (pin: DesignComment) => void;
  onPick: (pin: DesignComment) => void;
}) {
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [page, setPage] = useState<string | null>(null);
  const shown = commentsTab(pins, { tab, page }, mids);
  const action = "ui-text-12 text-accent hover:text-accent-2 disabled:text-faint";
  const plain = "ui-text-12 text-muted enabled:hover:text-fg disabled:text-faint";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        {(["open", "resolved"] as const).map((t) => (
          <button
            key={t}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className={cx("flex h-7 items-center gap-1.5 rounded-md px-2.5 ui-text-12.5", tab === t ? "bg-raised text-fg" : "text-muted hover:text-fg")}
          >
            {t === "open" ? "Open" : "Resolved"} <span className="text-faint">{t === "open" ? shown.open : shown.resolved}</span>
          </button>
        ))}
        <span className="ml-auto">
          <Menu
            align="right"
            trigger={(open) => (
              <button aria-label="Page filter" onClick={open} className="flex h-7 items-center gap-1 rounded-md px-2 ui-text-12 text-muted hover:text-fg">
                {page === null ? "All pages" : pageFile(page)} <ChevronDown size={11} />
              </button>
            )}
            items={[{ label: "All pages", checked: page === null, onSelect: () => setPage(null) }, ...pages.map((p) => ({ label: pageFile(p), checked: page === p, onSelect: () => setPage(p) }))]}
          />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.shown.length === 0 && shown.orphaned.length === 0 && (
          <p className="px-4 py-6 text-center ui-text-12.5 text-faint">{tab === "open" ? "No open comments. In Comment mode (C), click an element to pin one." : "No resolved comments."}</p>
        )}
        {shown.shown.map((p) => (
          <article key={p.n} aria-label={`Comment ${p.n}`} className="flex gap-2.5 border-b border-border px-3.5 py-3">
            <PinBadge n={p.n} />
            <div className="min-w-0 flex-1">
              <button className="block w-full truncate text-left font-mono ui-text-11.5 text-faint hover:text-muted" onClick={() => onPick(p)}>
                {pinLabel(p)}
              </button>
              <p className="selectable mt-0.5 whitespace-pre-wrap break-words ui-text-13 text-fg">{p.comment}</p>
              <div className="mt-1 flex items-center gap-3">
                <span className={cx("mr-auto ui-text-12", p.sent_at === null ? "text-accent" : "text-faint")}>{sentLabel(p)}</span>
                {p.state === "open" &&
                  (p.sent_at === null ? (
                    <button className={action} disabled={!rail.send || sending.includes(p.n)} title={rail.send ? undefined : (rail.why ?? undefined)} onClick={() => onSend(p)}>
                      {sending.includes(p.n) ? "Sending…" : "Send"}
                    </button>
                  ) : (
                    <button className={action} onClick={() => onShowInChat(p)}>
                      Show in chat
                    </button>
                  ))}
                {p.state === "open" && (
                  <button className={plain} disabled={!rail.resolve} title={rail.resolve ? undefined : (rail.why ?? undefined)} onClick={() => onResolve(p)}>
                    Resolve
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}
        {shown.orphaned.length > 0 && (
          <section aria-label="Orphaned" className="px-3.5 py-3">
            <h3 className="mb-2 ui-text-11 font-semibold uppercase tracking-[0.12em] text-faint">
              Orphaned <span className="font-normal">{shown.orphaned.length}</span>
            </h3>
            {shown.orphaned.map((p) => (
              <article key={p.n} aria-label={`Comment ${p.n}`} className="mb-2 rounded-lg border border-dashed border-border-strong px-3 py-2.5">
                <p className="truncate font-mono ui-text-11.5 text-faint">{p.page ? pinLabel(p) : `Comment ${p.n}`}</p>
                <p className="selectable mt-0.5 ui-text-13 text-muted">{p.comment}</p>
                <p className="mt-1 ui-text-12 text-faint">
                  The element is gone after the last change.{" "}
                  <button className={action} disabled={!rail.resolve} title={rail.resolve ? undefined : (rail.why ?? undefined)} onClick={() => onResolve(p)}>
                    Resolve
                  </button>
                </p>
              </article>
            ))}
          </section>
        )}
      </div>
      {tab === "open" && (
        <div className="flex h-12 shrink-0 items-center gap-2 border-t border-border px-3.5">
          <span className="min-w-0 flex-1 truncate ui-text-12 text-muted">{footerLabel(shown.unsent)}</span>
          <Button size="sm" variant="subtle" disabled={!shown.unsent || !rail.send} title={rail.send ? undefined : (rail.why ?? undefined)} onClick={onSendAll}>
            Send all
          </Button>
        </div>
      )}
    </div>
  );
}

/** A chat message of comments: one **Comment from the canvas** card per
 *  line, numbered like its pin, each found by Show in chat. */
export function CommentCards({ cards }: { cards: (CommentRef & { n: number | null })[] }) {
  return (
    <div className="flex flex-col items-end gap-1.5 py-1">
      {cards.map((c, i) => (
        <div key={i} {...{ [COMMENT_PIN_ATTR]: c.n ?? undefined }} className="max-w-[85%] rounded-2xl rounded-br-md bg-raised px-3.5 py-2.5 transition-shadow">
          <p className="mb-1 flex items-center gap-2 ui-text-12 text-muted">
            <PinBadge n={c.n} />
            Comment from the canvas
          </p>
          <p className="selectable whitespace-pre-wrap break-words font-mono ui-text-12 leading-relaxed text-fg">{commentLine(c)}</p>
        </div>
      ))}
    </div>
  );
}

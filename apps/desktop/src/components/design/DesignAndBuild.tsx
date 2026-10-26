// The PR's Design and build (X65): each page of a session design beside the
// screenshot of its built screen, which the agent saves after implementing
// it (`.moonlet/design/<slug>/built/<page>.png`). It is a section of the
// PR's Checks tab (X2's PR panel, the right panel's Review tab), and a view
// of the session's Design tab.

import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { Design, Session } from "../../lib/protocol";
import { buildRowShows, designBuild, type BuildRow as BuildRowView } from "../../lib/designBuild";
import { builtRevOf, pageRevOf, useDesign } from "../../lib/designStore";
import { designUrl, pageUrl } from "../../lib/designView";
import { useSize } from "../../lib/useSize";
import { NEAR_ROOT, useNear } from "../../lib/useNear";
import { CardFrame } from "./Frame";
import { cx } from "../../lib/cx";

/** Design and build of `design`: each screenshot tried by its image, and
 *  again, its address carrying `builtRev`, as its agent saves some in
 *  `built/`; `seen` records what each image found. */
function useDesignBuild(host: string, ws: Session, design: Design) {
  const place = useMemo(() => ({ session: ws.id }), [ws.id]);
  const builtRev = useDesign((d) => builtRevOf(d, host, place, design.slug));
  const [found, setFound] = useState<Record<string, boolean>>({});
  const seen = useCallback((page: string, there: boolean) => setFound((f) => (f[page] === there ? f : { ...f, [page]: there })), []);
  return { place, builtRev, seen, view: designBuild(design, ws.path, found) };
}

/** The Design tab's view: Design and build, with **Canvas** back. */
export function DesignAndBuild({ host, ws, design, onBack }: { host: string; ws: Session; design: Design; onBack: () => void }) {
  const { place, builtRev, seen, view } = useDesignBuild(host, ws, design);
  return (
    <section aria-label="Design and build" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[42px] shrink-0 items-center gap-2.5 border-b border-border px-4">
        <span className="ui-text-13.5 font-medium text-fg">{view.title}</span>
        <span className="min-w-0 truncate ui-text-12.5 text-muted">{view.line}</span>
        <span className="flex-1" />
        <button onClick={onBack} className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 ui-text-12.5 text-muted hover:bg-panel-2 hover:text-fg">
          <ArrowLeft size={12} /> Canvas
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4" {...{ [NEAR_ROOT]: "" }}>
        {view.rows.map((r) => (
          <BuildRow key={r.page} host={host} place={place} slug={design.slug} row={r} viewport={view.viewport} builtRev={builtRev} seen={seen} />
        ))}
      </div>
    </section>
  );
}

/** The PR's Checks tab's section: Design and build of a session design. */
export function DesignBuildSection({ host, ws, design }: { host: string; ws: Session; design: Design }) {
  const { place, builtRev, seen, view } = useDesignBuild(host, ws, design);
  return (
    <section aria-label={`Design and build · ${design.name}`} className="mb-4">
      <h3 className="mb-1 ui-text-11 font-semibold uppercase tracking-wider text-faint">{view.title}</h3>
      <p className="mb-2.5 ui-text-12 text-muted">
        {design.name} · {view.line}
      </p>
      {view.rows.map((r) => (
        <BuildRow key={r.page} host={host} place={place} slug={design.slug} row={r} viewport={view.viewport} builtRev={builtRev} seen={seen} />
      ))}
    </section>
  );
}

/** One page of Design and build: the page as it is now, framed only near
 *  the screen (buildRowShows), beside its built screenshot. */
function BuildRow({ host, place, slug, row, viewport, builtRev, seen }: { host: string; place: { session: string }; slug: string; row: BuildRowView; viewport: [number, number]; builtRev: number; seen: (page: string, there: boolean) => void }) {
  const rev = useDesign((d) => pageRevOf(d, host, place, slug, row.page));
  const ref = useRef<HTMLElement>(null);
  const shows = buildRowShows(row, useNear(ref));
  return (
    <article ref={ref} aria-label={`${row.page} design and build`} className="mb-5 grid grid-cols-2 gap-4">
      <BuildTile url={pageUrl(place, slug, row.page, rev)} live={shows.frame} title={`${row.page} design`} viewport={viewport} caption={["design", row.design]} />
      <BuildTile
        image={shows.image ? designUrl(place, row.built, builtRev) : null}
        imageShown={shows.shown}
        onImage={(there) => seen(row.page, there)}
        title={`${row.page} built`}
        viewport={viewport}
        caption={["built", row.builtLabel ?? ""]}
        empty={row.builtLabel ?? ""}
      />
    </article>
  );
}

/** A page (`url`, framed as on the canvas while `live`) or its built
 *  screenshot (`image`, scaled to fit whatever its pixel density, tried
 *  hidden and shown once `imageShown`, `onImage` told whether it loaded),
 *  fitted to the column, and what it is under it. */
function BuildTile({
  url = null,
  live = true,
  image = null,
  imageShown = false,
  onImage,
  title,
  viewport,
  caption,
  empty = "",
}: {
  url?: string | null;
  live?: boolean;
  image?: string | null;
  imageShown?: boolean;
  onImage?: (there: boolean) => void;
  title: string;
  viewport: [number, number];
  caption: [string, string];
  empty?: string;
}) {
  const [ref, [width]] = useSize<HTMLDivElement>();
  const scale = width ? width / viewport[0] : 0;
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <div ref={ref} className="relative w-full overflow-hidden rounded-md border border-border-strong bg-bg" style={{ aspectRatio: `${viewport[0]} / ${viewport[1]}` }}>
        {image && (
          <img
            src={image}
            alt={title}
            loading="lazy"
            onLoad={() => onImage?.(true)}
            onError={() => onImage?.(false)}
            className={cx("absolute inset-0 h-full w-full object-contain object-top", !imageShown && "invisible")}
          />
        )}
        {image ? (
          !imageShown && <span className="absolute inset-0 flex items-center justify-center ui-text-12.5 text-faint">{empty}</span>
        ) : url && scale > 0 ? (
          <CardFrame url={url} title={title} viewport={viewport} scale={scale} live={live} />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center ui-text-12.5 text-faint">{empty}</span>
        )}
      </div>
      <figcaption className="truncate ui-text-12 text-muted">
        <span className="font-mono text-fg">{caption[0]}</span> · {caption[1]}
      </figcaption>
    </figure>
  );
}

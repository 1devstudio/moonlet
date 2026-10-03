import { Fragment, useRef } from "react";
import { type PaneNode, setSizes } from "../lib/layout";
import { getLayout, setLayout } from "../lib/store";
import { Splitter } from "./Splitter";
import { TerminalPane } from "./TerminalPane";
import { AgentView } from "./AgentView";
import { useStore } from "../lib/store";

interface Props {
  host: string;
  wsId: string;
  tabId: string;
  node: PaneNode;
  path: number[];
  focused: number | null;
  visible: boolean;
}

export function PaneTree({ host, wsId, tabId, node, path, focused, visible }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chat = useStore((s) => (node.type === "leaf" ? !!s.terminals[host]?.[node.session]?.chat : false));
  if (node.type === "leaf") {
    if (chat) return <AgentView host={host} id={node.session} wsId={wsId} focused={focused === node.session} visible={visible} />;
    return <TerminalPane host={host} session={node.session} wsId={wsId} focused={focused === node.session} visible={visible} />;
  }
  const row = node.dir === "row";
  const resize = (i: number, deltaPx: number) => {
    const total = row ? box.current?.clientWidth : box.current?.clientHeight;
    if (!total) return;
    const delta = (deltaPx / total) * 100;
    const sizes = [...node.sizes];
    const a = sizes[i] + delta;
    const b = sizes[i + 1] - delta;
    if (a < 8 || b < 8) return;
    sizes[i] = a;
    sizes[i + 1] = b;
    const layout = getLayout(host, wsId);
    setLayout(host, wsId, {
      ...layout,
      tabs: layout.tabs.map((t) => (t.id === tabId ? { ...t, root: setSizes(t.root, path, sizes) } : t)),
    });
  };
  return (
    <div ref={box} className={row ? "flex h-full w-full flex-row" : "flex h-full w-full flex-col"}>
      {node.children.map((child, i) => (
        <Fragment key={child.type === "leaf" ? `l${child.session}` : `s${i}`}>
          {i > 0 && <Splitter dir={node.dir} onDrag={(d) => resize(i - 1, d)} />}
          <div style={{ flexBasis: `${node.sizes[i]}%` }} className="min-h-0 min-w-0 grow-0 shrink">
            <PaneTree host={host} wsId={wsId} tabId={tabId} node={child} path={[...path, i]} focused={focused} visible={visible} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

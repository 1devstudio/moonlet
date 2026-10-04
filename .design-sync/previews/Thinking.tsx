import { Thinking } from "@jaunt/ds";

export const Done = () => (
  <div className="bg-bg p-3" style={{ width: 480 }}>
    <Thinking item={{ id: "t1", kind: "thinking", text: "The button has a fixed width; check the stylesheet before touching the component.", ts: 0 }} />
  </div>
);

export const Streaming = () => (
  <div className="bg-bg p-3" style={{ width: 480 }}>
    <Thinking item={{ id: "t2", kind: "thinking", text: "Looking at the layout", ts: 0, partial: true }} />
  </div>
);

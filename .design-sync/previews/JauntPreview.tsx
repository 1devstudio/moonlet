import { JauntPreview, Sidebar } from "@jaunt/ds";

export const SelectedSession = () => (
  <JauntPreview selected="s-search">
    <div className="overflow-hidden bg-panel" style={{ width: 280, height: 540 }}>
      <Sidebar />
    </div>
  </JauntPreview>
);

import { JauntPreview, Sidebar } from "@jaunt/ds";

export const Default = () => (
  <JauntPreview>
    <div className="overflow-hidden bg-panel" style={{ width: 280, height: 640 }}>
      <Sidebar />
    </div>
  </JauntPreview>
);

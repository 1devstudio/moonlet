import { MoonletPreview, Sidebar } from "@moonlet/ds";

export const SelectedSession = () => (
  <MoonletPreview selected="s-search">
    <div className="overflow-hidden bg-panel" style={{ width: 280, height: 540 }}>
      <Sidebar />
    </div>
  </MoonletPreview>
);

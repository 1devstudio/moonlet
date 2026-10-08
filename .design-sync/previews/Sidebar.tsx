import { MoonletPreview, Sidebar } from "@moonlet/ds";

export const Default = () => (
  <MoonletPreview>
    <div className="overflow-hidden bg-panel" style={{ width: 280, height: 640 }}>
      <Sidebar />
    </div>
  </MoonletPreview>
);

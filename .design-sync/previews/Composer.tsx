import { Composer, MoonletPreview } from "@moonlet/ds";

export const NewSession = () => (
  <MoonletPreview>
    <div className="bg-bg p-6" style={{ width: 820, height: 420 }}>
      <Composer host="local" project="p-web" workspace="w-main" />
    </div>
  </MoonletPreview>
);

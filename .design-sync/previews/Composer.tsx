import { Composer, JauntPreview } from "@jaunt/ds";

export const NewSession = () => (
  <JauntPreview>
    <div className="bg-bg p-6" style={{ width: 820, height: 420 }}>
      <Composer host="local" project="p-web" workspace="w-main" />
    </div>
  </JauntPreview>
);

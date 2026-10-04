import { Button, Dialog, Field, inputCls } from "@jaunt/ds";

export const CommitChanges = () => (
  <div className="bg-bg" style={{ width: 640, height: 420 }}>
    <Dialog
      title="Commit changes"
      onClose={() => {}}
      footer={
        <>
          <Button variant="ghost">Cancel</Button>
          <Button variant="primary">Commit 3 files</Button>
        </>
      }
    >
      <Field label="Message">
        <input className={inputCls} defaultValue="fix(checkout): let the button fit small screens" />
      </Field>
    </Dialog>
  </div>
);

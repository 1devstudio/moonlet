import { Button, icons } from "@moonlet/ds";

const { GitPullRequest, Play } = icons;

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-2 bg-bg p-4">
    <Button variant="primary">Create PR</Button>
    <Button>Open in Cursor</Button>
    <Button variant="ghost">Cancel</Button>
    <Button variant="danger">Archive session</Button>
  </div>
);

export const Small = () => (
  <div className="flex items-center gap-1.5 bg-bg p-4">
    <Button size="sm" variant="primary">Allow</Button>
    <Button size="sm">Always allow</Button>
    <Button size="sm" variant="ghost">Deny</Button>
  </div>
);

export const WithIcons = () => (
  <div className="flex items-center gap-2 bg-bg p-4">
    <Button>
      <Play size={12} /> Run
    </Button>
    <Button variant="primary">
      <GitPullRequest size={13} /> Create PR
    </Button>
  </div>
);

export const Disabled = () => (
  <div className="flex items-center gap-2 bg-bg p-4">
    <Button variant="primary" disabled>Commit</Button>
    <Button disabled>Push</Button>
  </div>
);

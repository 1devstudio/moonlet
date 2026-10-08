import { Empty, icons } from "@moonlet/ds";

const { FileDiff, Search } = icons;

export const NoChanges = () => (
  <div className="bg-bg" style={{ width: 360, height: 220 }}>
    <Empty icon={<FileDiff size={22} />} title="No changes yet">Nothing differs from main.</Empty>
  </div>
);

export const NoResults = () => (
  <div className="bg-bg" style={{ width: 360, height: 220 }}>
    <Empty icon={<Search size={22} />} title="No sessions match">Try another project filter.</Empty>
  </div>
);

// What the phone asks the Mac to do with tasks (X57): moves shown at once
// until the Mac's next snapshot has them.

import { create } from "zustand";
import type { Moving } from "./board";

const useTaskStore = create<{ moving: Moving }>(() => ({ moving: {} }));

/** Moves the phone asked for and the Mac has not shared yet. */
export const useTaskMoves = () => useTaskStore((s) => s.moving);

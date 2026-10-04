// jaunt's design system for Claude Design: the presentational components plus
// the app screens, which render with demo data inside <JauntPreview>.
// Built by `pnpm build:ds` into ds/dist; not used by the app itself.

// Installs the daemon stub before any component module loads.
import "./tauri-stub";
import "./ds.css";

export { Button, IconButton, Kbd, StateGlyph, AgentIcon, DiffStat, Dialog, Field, Empty, cx, inputCls } from "../components/ui";
export { Menu, MenuItems, type MenuItem } from "../components/Menu";
export {
  Markdown,
  StatusMark,
  DiffBlock,
  ToolRow,
  Thinking,
  ChatItemView,
  PermissionCard,
  QuestionCard,
  AgentView,
} from "../components/AgentView";
export { Sidebar } from "../components/Sidebar";
export { Composer } from "../components/Composer";
export { JauntPreview, seedPreview, DEMO_HOST, demoChatItems, type PreviewState } from "./preview";
export type { AgentState, ChatItem, ChatState, PermissionAsk, ToolCall } from "../lib/protocol";

// The icon set jaunt's UI uses (lucide-react), for designs built with it.
import {
  Archive, ArrowRight, Bot, Check, ChevronDown, ChevronRight, Copy, FileDiff, FileText, Folder, FolderPlus,
  GitBranch, GitPullRequest, Globe, History, Loader2, Lock, MessageSquarePlus, MoreHorizontal, Pencil, Play,
  Plus, RotateCw, Save, Search, Server, Settings, ShieldAlert, Square, SquareTerminal, Terminal, Trash2, Undo2, X,
} from "lucide-react";
export const icons = {
  Archive, ArrowRight, Bot, Check, ChevronDown, ChevronRight, Copy, FileDiff, FileText, Folder, FolderPlus,
  GitBranch, GitPullRequest, Globe, History, Loader2, Lock, MessageSquarePlus, MoreHorizontal, Pencil, Play,
  Plus, RotateCw, Save, Search, Server, Settings, ShieldAlert, Square, SquareTerminal, Terminal, Trash2, Undo2, X,
};

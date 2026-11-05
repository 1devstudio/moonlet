import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../styles/system/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "moonlet: your coding agents on every machine you own", template: "%s · moonlet docs" },
  description:
    "An agent-first terminal for macOS. Run Claude Code and Codex in git worktrees across your Macs, a Linux box and your iPhone. Free and open source.",
};

export const viewport: Viewport = { themeColor: "#121212", colorScheme: "dark" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* Browser extensions such as Grammarly add attributes to <body> before React
          loads; this ignores those, and only on <body> itself, not its children. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}

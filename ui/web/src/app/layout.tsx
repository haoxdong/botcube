import "./globals.css";
import "./files.css";
import "./side-chats.css";
import "./scheduled-tasks.css";
import "./code-blocks.css";
import "./motion.css";
import "./step-sheet.css";
import "../computer/styles.css";
import "../computer/files-menu.css";
import localFont from "next/font/local";
import { cn } from "@/lib/utils";
import { webUiPlugin } from "@cartridge-ui";

const geist = localFont({
  src: './fonts/Geist.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-sans',
});

export const viewport = {
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export const metadata = {
  title: webUiPlugin.config.title,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)}>
      <body>{children}</body>
    </html>
  );
}

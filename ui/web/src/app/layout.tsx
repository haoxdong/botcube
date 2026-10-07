import "./globals.css";
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

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pinsk — AI assistant",
  description: "Your personal AI assistant",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}

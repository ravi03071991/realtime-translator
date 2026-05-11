import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Realtime EN → JA Translator",
  description: "Live English to Japanese speech translation via OpenAI Realtime API",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

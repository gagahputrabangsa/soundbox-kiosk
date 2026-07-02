import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Soundbox AI Kiosk",
  description: "AI-powered voice ordering kiosk for your coffeeshop. Powered by Nebula Realtime Voice.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}

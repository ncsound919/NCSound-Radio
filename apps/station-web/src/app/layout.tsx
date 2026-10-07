import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NCSound Radio | Independent Hip-Hop Radio",
  description:
    "The Carolinas' independent hip-hop signal. Live stream, artist submissions, weekly show schedule, and sponsor proof-of-play reporting.",
  keywords: [
    "radio station",
    "hip-hop radio",
    "NCSound Radio",
    "NCSound Radio",
    "internet radio",
    "artist submissions",
  ],
  icons: {
    icon: "/station-logo.png",
    apple: "/station-logo.png",
  },
  manifest: "/manifest.webmanifest",
  applicationName: "NCSound Radio",
  appleWebApp: {
    capable: true,
    title: "NCSound Radio",
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    title: "NCSound Radio",
    description: "The Carolinas' independent hip-hop signal. Streaming 24/7.",
    siteName: "NCSound Radio",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#16130f",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
        <Sonner position="bottom-right" richColors theme="dark" />
      </body>
    </html>
  );
}

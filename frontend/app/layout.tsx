import type { Metadata } from "next";
import { Inter, Silkscreen } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const silkscreen = Silkscreen({
  variable: "--font-silkscreen",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Aegis Alpha — Private Autonomous Trading",
  description:
    "An autonomous trading agent that reasons inside hardware-isolated compute and executes through shielded, MEV-proof rails — verifiable end-to-end, visible to no one.",
  openGraph: {
    title: "Aegis Alpha — Capital Designed To Vanish",
    description:
      "TEE-attested AI decisions. Railgun-shielded execution. ERC-4337 session keys. Verifiable privacy for autonomous DeFi.",
    type: "website",
  },
};

import { Web3Provider } from '@/components/providers/Web3Provider';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${silkscreen.variable} h-full`}
    >
      <head>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" integrity="sha512-SnH5WK+bZxgPHs44uWIX+LLJAJ9/2PkPKZ5QiAj6Ta86w+fsb2TkcmfRyVX3pBnMFcV7oQPJkl9QevSCWr3W6A==" crossOrigin="anonymous" referrerPolicy="no-referrer" />
        <link href="https://db.onlinewebfonts.com/c/8cb707a9b8a73f8a7403336b861c3074?family=BubbledotICG-FinePos" rel="stylesheet" />
      </head>
      <body className="min-h-dvh overflow-x-hidden bg-bg text-text antialiased">
        <Web3Provider>
          {children}
        </Web3Provider>
      </body>
    </html>
  );
}

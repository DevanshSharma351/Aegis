'use client';

import React from 'react';
import { useAccount } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { StatsFooter } from '@/components/stats/StatsFooter';
import { DockNav } from '@/components/hero/DockNav';
import { TrustCenter } from '@/components/sections/TrustCenter';
import { ActivityLog } from '@/components/sections/ActivityLog';
import { HeroCTA } from '@/components/hero/HeroCTA';
import { DepositorView } from '@/components/sections/DepositorView';
import { AdminConsole } from '@/components/sections/AdminConsole';
import { DocsSection } from '@/components/sections/DocsSection';
import { Spotlight } from '@/components/core/spotlight';
import { useState } from 'react';

export default function Home() {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [isNavHovered, setIsNavHovered] = useState(false);

  const handleGetStarted = () => {
    if (isConnected) {
      document.getElementById('depositor')?.scrollIntoView({ behavior: 'smooth' });
    } else if (openConnectModal) {
      openConnectModal();
    }
  };

  return (
    <>
      {/* Background Video */}
      <div className="bg">
        <video className="bg-video" autoPlay muted loop playsInline>
          <source src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4" type="video/mp4" />
        </video>
      </div>

      <div className="page-container">
        {/* Dock Navigation (Fixed Bottom) */}
        <DockNav onHoverChange={setIsNavHovered} />

        {/* Hero Section */}
        <main className="hero relative z-20">
          <div className="trust-row anim" style={{ '--d': '0.05s' } as React.CSSProperties}>
            <div className="avatars">
              <div className="avatar a1"><i className="fa-brands fa-ethereum"></i></div>
              <div className="avatar a2"><i className="fa-brands fa-monero"></i></div>
              <div className="avatar a3"><i className="fa-brands fa-linux"></i></div>
              <div className="trust-pill">Trusted Execution Environment</div>
            </div>
          </div>

          <h1 className="headline anim">
            <span className="line1">Aegis</span><br/>
            <span className="line2">Private Trading</span>
          </h1>

          <p className="subhead anim" style={{ '--d': '0.28s' } as React.CSSProperties}>
            An autonomous trading agent that reasons inside hardware-isolated compute and executes through shielded, MEV-proof rails.
          </p>

          <HeroCTA isConnected={isConnected} onClick={handleGetStarted} />
        </main>

        {/* Stats Footer */}
        <div className="w-full relative z-10 bg-gradient-to-b from-transparent via-black/50 to-black pt-4 pb-48 flex justify-center">
          <StatsFooter />
        </div>
        
        {/* Scrollable Sections - Only show when authenticated */}
        <div className="w-full bg-black relative z-10 flex flex-col group min-h-screen">
          {/* Global Background Spotlight + Grid */}
          <Spotlight
            className={`transition-opacity duration-500 from-white/[0.15] via-white/[0.07] to-transparent blur-3xl ${isNavHovered ? 'opacity-0' : 'opacity-100'}`}
            size={250}
          />
          <div className="absolute inset-0 pointer-events-none z-0 opacity-40 mix-blend-screen">
            <svg className="h-full w-full">
              <defs>
                <pattern
                  id="dashboard-grid-pattern"
                  width="32"
                  height="32"
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d="M0 32H32M32 32V0M32 32H64M32 32V64"
                    stroke="currentColor"
                    strokeOpacity="0.1"
                    className="stroke-white"
                  />
                  <rect
                    x="15"
                    y="15"
                    width="2"
                    height="2"
                    fill="currentColor"
                    fillOpacity="0.2"
                    className="fill-white"
                  />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#dashboard-grid-pattern)" />
            </svg>
          </div>

          <div className="relative z-10">
            {/* Wallet-gated: these are user actions, so they need an account. */}
            {isConnected ? (
              <>
                <DepositorView />
                <AdminConsole />
              </>
            ) : (
              <div className="py-24 text-center">
                <p className="text-muted mb-4">Connect a wallet to deposit or manage the agent.</p>
                <p className="text-sm text-white/40">
                  Verification below is public — no wallet required.
                </p>
              </div>
            )}

            {/*
              NOT gated. The Trust Center and Activity Log read public Sepolia
              state and exist so a sceptic can check the protocol's claims
              independently. Requiring a wallet connection to see the proofs
              would defeat the point of publishing them.
            */}
            <TrustCenter />
            <ActivityLog />
            <DocsSection />
          </div>
        </div>

        {/* Spacer for Dock Nav on smaller screens so content isn't hidden behind it */}
        <div className="h-32 w-full shrink-0 bg-black relative z-10"></div>
      </div>
    </>
  );
}

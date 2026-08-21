'use client';

import React from 'react';
import { useAccount } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { StatsFooter } from '@/components/stats/StatsFooter';
import { DockNav } from '@/components/hero/DockNav';
import { TrustCenter } from '@/components/sections/TrustCenter';
import { ActivityLog } from '@/components/sections/ActivityLog';
import { DepositorView } from '@/components/sections/DepositorView';
import { AdminConsole } from '@/components/sections/AdminConsole';
import { DocsSection } from '@/components/sections/DocsSection';

export default function Home() {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();

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
        <DockNav />

        {/* Hero Section */}
        <main className="hero">
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

          <div className="cta-wrapper anim" style={{ '--d': '0.4s' } as React.CSSProperties}>
            <button className="cta" onClick={handleGetStarted}>
              {isConnected ? 'View Dashboard' : 'Connect Wallet to Start'}
            </button>
          </div>
        </main>

        {/* Stats Footer */}
        <div className="w-full relative z-10 bg-gradient-to-b from-transparent to-black/80 pt-12 pb-24 flex justify-center">
          <StatsFooter />
        </div>
        
        {/* Scrollable Sections - Only show when authenticated */}
        <div className="w-full bg-black relative z-10 flex flex-col">
          {isConnected ? (
            <>
              <DepositorView />
              <AdminConsole />
              <TrustCenter />
              <ActivityLog />
              <DocsSection />
            </>
          ) : (
            <div className="py-24 text-center">
              <p className="text-muted mb-4">Authentication required to view dashboard features.</p>
              <p className="text-sm text-white/40">Please connect your wallet using the navbar below.</p>
            </div>
          )}
        </div>

        {/* Spacer for Dock Nav on smaller screens so content isn't hidden behind it */}
        <div className="h-32 w-full shrink-0 bg-black relative z-10"></div>
      </div>
    </>
  );
}

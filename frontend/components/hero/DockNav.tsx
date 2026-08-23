'use client';

import React from 'react';
import {
  Activity,
  Terminal,
  HomeIcon,
  BookOpen,
  ShieldCheck,
} from 'lucide-react';

import { Dock, DockIcon, DockItem, DockLabel } from '@/components/core/dock';

const data = [
  {
    title: 'Home',
    icon: (
      <HomeIcon className='h-full w-full text-white/70' />
    ),
    href: '#home',
  },
  {
    title: 'Attest',
    icon: (
      <ShieldCheck className='h-full w-full text-white/70' />
    ),
    href: '#attestation',
  },
  {
    title: 'Docs',
    icon: (
      <BookOpen className='h-full w-full text-white/70' />
    ),
    href: '#docs',
  },
  {
    title: 'Logs',
    icon: (
      <Activity className='h-full w-full text-white/70' />
    ),
    href: '#logs',
  },
  {
    title: 'Agent',
    icon: (
      <Terminal className='h-full w-full text-white/70' />
    ),
    href: '#run-aegis',
  },
];

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Wallet } from 'lucide-react';

export function DockNav({ onHoverChange }: { onHoverChange?: (hovered: boolean) => void }) {
  return (
    <div 
      className='fixed bottom-6 left-1/2 z-50 -translate-x-1/2'
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <Dock className='items-end pb-3 bg-white/[0.02] backdrop-blur-xl border border-white/[0.05] hover:bg-white/[0.1] hover:border-white/[0.12] hover:shadow-[0_0_20px_rgba(255,255,255,0.08)] transition-all duration-500 rounded-2xl px-2 py-1 shadow-2xl'>
        {data.map((item, idx) => (
          <DockItem
            key={idx}
            className='aspect-square rounded-full bg-white/[0.04] hover:bg-white/[0.08] transition-colors border border-white/5 cursor-pointer'
            onClick={() => {
              // Navigation is not a privileged action. Gating every icon behind
              // a wallet made the whole dock open the connect modal instead of
              // navigating, and the sections it scrolls to are public reads
              // that exist so a sceptic can check the claims without an account.
              if (item.href === '#home') {
                window.scrollTo({ top: 0, behavior: 'smooth' });
                return;
              }
              const el = document.querySelector(item.href);
              el?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            <DockLabel>{item.title}</DockLabel>
            <DockIcon>{item.icon}</DockIcon>
          </DockItem>
        ))}

        {/* Custom Connect Wallet Dock Item */}
        <ConnectButton.Custom>
          {({
            account,
            chain,
            openAccountModal,
            openChainModal,
            openConnectModal,
            authenticationStatus,
            mounted,
          }) => {
            const ready = mounted && authenticationStatus !== 'loading';
            const connected =
              ready &&
              account &&
              chain &&
              (!authenticationStatus ||
                authenticationStatus === 'authenticated');

            return (
              <div
                {...(!ready && {
                  'aria-hidden': true,
                  'style': {
                    opacity: 0,
                    pointerEvents: 'none',
                    userSelect: 'none',
                  },
                })}
              >
                <DockItem
                  className='aspect-square rounded-full bg-accent/10 hover:bg-accent/20 transition-colors border border-accent/20 cursor-pointer ml-2'
                  onClick={() => {
                    if (!connected && openConnectModal) {
                      openConnectModal();
                    }
                    if (connected && openAccountModal) {
                      openAccountModal();
                    }
                  }}
                >
                  <DockLabel>
                    {connected ? account.displayName : 'Connect Wallet'}
                  </DockLabel>
                  <DockIcon>
                    {connected && account.ensAvatar ? (
                      <img src={account.ensAvatar} alt="ENS Avatar" className="w-full h-full rounded-full" />
                    ) : (
                      <Wallet className={connected ? 'h-full w-full text-accent' : 'h-full w-full text-white'} />
                    )}
                  </DockIcon>
                </DockItem>
              </div>
            );
          }}
        </ConnectButton.Custom>
      </Dock>
    </div>
  );
}

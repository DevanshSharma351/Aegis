'use client';

import React, { useState } from 'react';
import { useAccount } from 'wagmi';
import { Shield, EyeOff, Coins, ArrowRightLeft, Lock } from 'lucide-react';
import { BorderTrail } from '@/components/core/border-trail';
import { TextMorph } from '@/components/core/text-morph';

// Mock owner address for demo
const VAULT_OWNER = '0x1234567890123456789012345678901234567890';

export function DepositorView() {
  const { address, isConnected } = useAccount();
  const [isShielding, setIsShielding] = useState(false);
  const [shieldAmount, setShieldAmount] = useState('');
  const [txHash, setTxHash] = useState('');

  // Role detection
  const isOwner = address?.toLowerCase() === VAULT_OWNER.toLowerCase();
  
  // For the hackathon demo, we'll show this to anyone who is connected and not the owner
  if (!isConnected || isOwner) return null;

  const handleShield = (e: React.FormEvent) => {
    e.preventDefault();
    setIsShielding(true);
    // Mock shielding delay
    setTimeout(() => {
      setTxHash('0xabc123...def456');
      setIsShielding(false);
    }, 2000);
  };

  return (
    <section id="depositor" className="w-full max-w-5xl mx-auto py-24 px-6 relative z-10 border-t border-white/5">
      <div className="mb-12 text-center anim" style={{ '--d': '0.1s' } as React.CSSProperties}>
        <h2 className="text-3xl md:text-5xl font-display mb-4 tracking-tighter bg-gradient-to-br from-white to-white/40 bg-clip-text text-transparent">Depositor Dashboard</h2>
        <p className="text-muted max-w-2xl mx-auto text-sm md:text-base leading-relaxed">
          Manage your shielded capital. All deposits are routed into the Railgun 0zk pool to ensure complete privacy from observers.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Shield Deposit Card */}
        <div className="glass-light p-8 rounded-3xl anim flex flex-col gap-6 relative overflow-hidden group hover:border-white/20 transition-all duration-500 hover:shadow-[0_0_40px_rgba(99,102,241,0.05)]" style={{ '--d': '0.2s' } as React.CSSProperties}>
          <BorderTrail size={180} className="bg-accent/50" style={{ boxShadow: '0 0 40px 10px rgba(99,102,241,0.3)' }} />
          <div className="absolute top-0 right-0 w-64 h-64 bg-accent/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>

          <div className="flex items-center gap-4 relative z-10">
            <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center border border-accent/20 shadow-[0_0_15px_rgba(99,102,241,0.15)]">
              <Shield className="text-accent w-7 h-7" />
            </div>
            <div>
              <h3 className="font-display tracking-wide text-lg text-white/90">Shield Funds</h3>
              <p className="text-sm text-muted mt-1 font-mono uppercase tracking-wider text-[10px]">Deposit into the private Railgun pool</p>
            </div>
          </div>

          <form onSubmit={handleShield} className="flex flex-col gap-4 mt-4 relative z-10">
            <div className="relative group/input">
              <input 
                type="number" 
                value={shieldAmount}
                onChange={(e) => setShieldAmount(e.target.value)}
                placeholder="Amount to shield..."
                className="w-full bg-black/60 border border-white/10 rounded-2xl px-5 py-4 text-white placeholder-white/30 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-all shadow-inner font-mono text-lg"
                required
              />
              <div className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold bg-white/5 border border-white/10 px-2.5 py-1.5 rounded-lg text-white/70 font-mono tracking-wider">
                USDC
              </div>
            </div>

            <div className="bg-shield-green/5 border border-shield-green/20 rounded-2xl p-4 flex items-start gap-3 shadow-inner">
              <Lock className="w-4 h-4 text-shield-green mt-0.5 shrink-0" />
              <p className="text-[11px] text-shield-green/80 leading-relaxed font-mono uppercase tracking-wider">
                A client-side viewing key will be generated. Keep this safe, it is required to view your balance and redeem funds.
              </p>
            </div>

            <button 
              type="submit"
              disabled={isShielding || !!txHash}
              className="w-full bg-white text-black hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:shadow-[0_0_20px_rgba(255,255,255,0.2)] rounded-2xl py-4 text-sm font-medium flex items-center justify-center gap-2 mt-2 font-mono uppercase tracking-wider"
            >
              <TextMorph>{isShielding ? 'Shielding Transaction...' : txHash ? 'Funds Shielded' : 'Generate Key & Shield'}</TextMorph>
            </button>

            {txHash && (
              <div className="text-center mt-3 p-3 bg-black/40 rounded-xl border border-white/5">
                <p className="text-[10px] text-muted font-mono uppercase tracking-wider mb-1">Shield TX Hash</p>
                <a href="#" className="text-xs text-accent hover:text-accent/80 transition-colors font-mono tracking-wider break-all">{txHash}</a>
              </div>
            )}
          </form>
        </div>

        {/* My Position Card (Gated) */}
        <div className="glass-light p-8 rounded-3xl anim flex flex-col gap-6 relative overflow-hidden group hover:border-white/20 transition-all duration-500 hover:shadow-[0_0_40px_rgba(255,255,255,0.05)]" style={{ '--d': '0.3s' } as React.CSSProperties}>
          <BorderTrail size={180} className="bg-white/20" style={{ boxShadow: '0 0 40px 10px rgba(255,255,255,0.1)' }} />
          <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>

          <div className="flex items-center gap-4 relative z-10">
            <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center border border-white/10 shadow-[0_0_15px_rgba(255,255,255,0.05)]">
              <Coins className="text-white w-7 h-7" />
            </div>
            <div>
              <h3 className="font-display tracking-wide text-lg text-white/90">My Position</h3>
              <p className="text-sm text-muted mt-1 font-mono uppercase tracking-wider text-[10px]">Client-side decrypted balance</p>
            </div>
          </div>

          <div className="flex-1 flex flex-col items-center justify-center py-8 relative z-10 bg-black/20 rounded-2xl border border-white/5 mt-2">
            {!txHash ? (
              <div className="text-center flex flex-col items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center border border-white/5">
                  <EyeOff className="w-6 h-6 text-white/30" />
                </div>
                <div>
                  <p className="text-sm text-muted font-mono uppercase tracking-wider text-[11px]">No viewing key detected</p>
                  <p className="text-[10px] text-white/40 mt-1">Shield funds to generate a key</p>
                </div>
              </div>
            ) : (
              <div className="text-center flex flex-col items-center gap-3 w-full px-6">
                <p className="text-[10px] text-muted font-mono uppercase tracking-wider">Decrypted Balance</p>
                <div className="bg-black/40 w-full py-6 rounded-2xl border border-white/10 shadow-inner">
                  <h4 className="text-5xl font-mono text-white tracking-tighter">
                    {shieldAmount}<span className="text-white/30">.00</span> 
                    <span className="text-lg text-white/50 ml-2 tracking-normal">USDC</span>
                  </h4>
                </div>
                <p className="text-[11px] text-shield-green mt-3 flex items-center gap-1.5 font-mono uppercase tracking-wider bg-shield-green/10 px-3 py-1.5 rounded-lg border border-shield-green/20">
                  <Shield className="w-3.5 h-3.5" /> Railgun 0zk Pool
                </p>
              </div>
            )}
          </div>

          <div className="pt-6 border-t border-white/5 mt-auto relative z-10">
            <button 
              disabled={!txHash}
              className="w-full flex items-center justify-center gap-2 bg-red-500/5 hover:bg-red-500/10 text-red-400 disabled:opacity-50 transition-colors border border-red-500/10 rounded-2xl py-4 text-sm font-medium font-mono uppercase tracking-wider"
            >
              <ArrowRightLeft className="w-4 h-4" />
              <TextMorph>Request Exit (Redeem)</TextMorph>
            </button>
            <p className="text-[10px] text-center text-muted mt-3 font-mono uppercase tracking-wider opacity-60">
              Withdrawals require agent un-shielding phase to complete.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

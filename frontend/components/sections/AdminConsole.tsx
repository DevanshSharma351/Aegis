'use client';

import React, { useState } from 'react';
import { useAccount } from 'wagmi';
import { Settings, PauseCircle, KeyRound, Cpu, AlertTriangle, ShieldAlert } from 'lucide-react';
import { TextMorph } from '@/components/core/text-morph';
import { BorderTrail } from '@/components/core/border-trail';

// Mock owner address for demo
const VAULT_OWNER = '0x1234567890123456789012345678901234567890';

export function AdminConsole() {
  const { address, isConnected } = useAccount();
  const [isPaused, setIsPaused] = useState(false);

  // Role detection
  const isOwner = address?.toLowerCase() === VAULT_OWNER.toLowerCase();
  
  if (!isConnected || !isOwner) return null;

  return (
    <section id="admin" className="w-full max-w-5xl mx-auto py-24 px-6 relative z-10 border-t border-red-500/10">
      <div className="mb-12 text-center anim" style={{ '--d': '0.1s' } as React.CSSProperties}>
        <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/20 text-red-500 rounded-lg text-xs font-semibold uppercase tracking-widest mb-6 font-mono shadow-[0_0_15px_rgba(239,68,68,0.2)]">
          <ShieldAlert className="w-3.5 h-3.5" /> Owner Privileges Active
        </div>
        <h2 className="text-3xl md:text-5xl font-display mb-4 tracking-tighter bg-gradient-to-br from-red-100 to-red-500/50 bg-clip-text text-transparent">Admin Console</h2>
        <p className="text-muted max-w-2xl mx-auto text-sm md:text-base leading-relaxed">
          Manage the AegisVault contract, rotate agent session keys, and handle emergency pauses.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Emergency Pause */}
        <div className="glass-light p-8 rounded-3xl anim flex flex-col border border-red-500/20 bg-red-500/5 relative overflow-hidden group hover:border-red-500/40 transition-all duration-500 hover:shadow-[0_0_40px_rgba(239,68,68,0.1)]" style={{ '--d': '0.2s' } as React.CSSProperties}>
          <BorderTrail size={180} className="bg-red-500/50" style={{ boxShadow: '0 0 40px 10px rgba(239,68,68,0.3)' }} />
          <div className="absolute top-0 right-0 w-64 h-64 bg-red-500/10 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>
          
          <div className="flex items-center gap-4 mb-6 relative z-10">
            <div className="w-12 h-12 rounded-2xl bg-red-500/10 flex items-center justify-center border border-red-500/20 shadow-[0_0_15px_rgba(239,68,68,0.2)]">
              <PauseCircle className="text-red-500 w-6 h-6" />
            </div>
            <h3 className="font-display tracking-wide text-lg text-red-100">Emergency Halt</h3>
          </div>
          <p className="text-[13px] text-red-400/80 mb-8 flex-1 relative z-10 leading-relaxed font-mono uppercase tracking-wider">
            Instantly revokes the agent's session key and pauses all rebalance and deposit functions.
          </p>
          <button 
            onClick={() => setIsPaused(!isPaused)}
            className={`w-full py-4 rounded-2xl text-sm font-medium transition-all relative z-10 font-mono uppercase tracking-wider ${
              isPaused 
                ? 'bg-red-500 text-white hover:bg-red-600 shadow-[0_0_20px_rgba(239,68,68,0.4)]' 
                : 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/20'
            }`}
          >
            <TextMorph>{isPaused ? 'Agent Paused (Resume)' : 'Halt Agent'}</TextMorph>
          </button>
        </div>

        {/* Rotate Session Key */}
        <div className="glass-light p-8 rounded-3xl anim flex flex-col relative overflow-hidden group hover:border-white/20 transition-all duration-500 hover:shadow-[0_0_40px_rgba(99,102,241,0.05)]" style={{ '--d': '0.3s' } as React.CSSProperties}>
          <BorderTrail size={180} className="bg-white/20" style={{ boxShadow: '0 0 40px 10px rgba(255,255,255,0.1)' }} />
          <div className="absolute top-0 right-0 w-64 h-64 bg-accent/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>

          <div className="flex items-center gap-4 mb-6 relative z-10">
            <div className="w-12 h-12 rounded-2xl bg-accent/10 flex items-center justify-center border border-accent/20 shadow-[0_0_15px_rgba(99,102,241,0.15)]">
              <KeyRound className="text-accent w-6 h-6" />
            </div>
            <h3 className="font-display tracking-wide text-lg text-white/90">Rotate Key</h3>
          </div>
          <p className="text-[13px] text-muted mb-8 flex-1 relative z-10 leading-relaxed font-mono uppercase tracking-wider">
            Re-bind the ZeroDev session key to a new ephemeral wallet. Requires a new hardware quote.
          </p>
          <button className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-white/90 transition-all hover:shadow-[0_0_20px_rgba(255,255,255,0.1)] rounded-2xl py-4 text-sm font-medium relative z-10 font-mono uppercase tracking-wider">
            <TextMorph>Initiate Rotation</TextMorph>
          </button>
        </div>

        {/* Update Measurement */}
        <div className="glass-light p-8 rounded-3xl anim flex flex-col relative overflow-hidden group hover:border-white/20 transition-all duration-500 hover:shadow-[0_0_40px_rgba(255,255,255,0.05)]" style={{ '--d': '0.4s' } as React.CSSProperties}>
          <BorderTrail size={180} className="bg-white/20" style={{ boxShadow: '0 0 40px 10px rgba(255,255,255,0.1)' }} />
          <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>

          <div className="flex items-center gap-4 mb-6 relative z-10">
            <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center border border-white/10 shadow-[0_0_15px_rgba(255,255,255,0.05)]">
              <Cpu className="text-white w-6 h-6" />
            </div>
            <h3 className="font-display tracking-wide text-lg text-white/90">Update Image</h3>
          </div>
          <p className="text-[13px] text-muted mb-4 flex-1 relative z-10 leading-relaxed font-mono uppercase tracking-wider">
            Update the authorized MRENCLAVE hash in the verifier.
          </p>
          <div className="bg-orange-500/5 border border-orange-500/20 rounded-xl p-3 flex items-start gap-2.5 mb-6 relative z-10 shadow-inner">
            <AlertTriangle className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" />
            <p className="text-[10px] text-orange-400/90 leading-relaxed font-mono uppercase tracking-wider">
              Subject to 48h timelock for depositor safety.
            </p>
          </div>
          <button className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-white/90 transition-all hover:shadow-[0_0_20px_rgba(255,255,255,0.1)] rounded-2xl py-4 text-sm font-medium relative z-10 font-mono uppercase tracking-wider">
            <TextMorph>Propose New Hash</TextMorph>
          </button>
        </div>
      </div>
    </section>
  );
}

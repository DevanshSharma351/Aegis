'use client';

import React, { useState, useEffect } from 'react';
import { Activity, Clock, CheckCircle2, ArrowRight } from 'lucide-react';
import { BorderTrail } from '@/components/core/border-trail';

const mockLogs = [
  {
    id: 1,
    timestamp: Date.now() - 1000 * 60 * 60 * 12, // 12 hours ago
    txHash: '0x3a4b5c...8f9e',
    attestationPassed: true,
  },
  {
    id: 2,
    timestamp: Date.now() - 1000 * 60 * 60 * 36, // 36 hours ago
    txHash: '0x1e2d3c...4b5a',
    attestationPassed: true,
  },
  {
    id: 3,
    timestamp: Date.now() - 1000 * 60 * 60 * 60, // 60 hours ago
    txHash: '0x9f8e7d...6c5b',
    attestationPassed: true,
  }
];

export function ActivityLog() {
  const [nextExecution, setNextExecution] = useState('12h 00m');

  // Mock live countdown
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      const target = new Date();
      target.setHours(target.getHours() + 12);
      target.setMinutes(0);
      target.setSeconds(0);
      
      const diff = target.getTime() - now.getTime();
      const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setNextExecution(`${h}h ${m}m`);
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section id="logs" className="w-full max-w-5xl mx-auto py-24 px-6 relative z-10">
      <div className="flex flex-col md:flex-row gap-12">
        {/* Header & Status Indicator */}
        <div className="md:w-1/3 flex flex-col gap-6 anim" style={{ '--d': '0.1s' } as React.CSSProperties}>
          <div>
            <h2 className="text-3xl font-display mb-3 tracking-tighter bg-gradient-to-br from-white to-white/40 bg-clip-text text-transparent">Activity Log</h2>
            <p className="text-muted text-sm leading-relaxed">
              All agent interactions with the Railgun shielded pool. Quantities are strictly obfuscated to preserve alpha.
            </p>
          </div>
          
          <div className="glass-light p-8 rounded-3xl flex flex-col gap-5 border-l-4 border-l-accent relative overflow-hidden group hover:shadow-[0_0_40px_rgba(99,102,241,0.05)] transition-shadow duration-500">
            <BorderTrail size={180} className="bg-accent/50" style={{ boxShadow: '0 0 40px 10px rgba(99,102,241,0.3)' }} />
            <div className="absolute top-0 right-0 w-32 h-32 bg-accent/5 rounded-full blur-2xl -mr-10 -mt-10 pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>
            <div className="flex items-center gap-4 relative z-10">
              <div className="relative">
                <div className="w-3.5 h-3.5 bg-accent rounded-full animate-ping absolute"></div>
                <div className="w-3.5 h-3.5 bg-accent rounded-full relative z-10 shadow-[0_0_10px_#6366f1]"></div>
              </div>
              <h3 className="font-display tracking-wide text-lg text-white">Agent Status: Idle</h3>
            </div>
            
            <div className="flex items-center gap-3 text-[13px] text-muted relative z-10 font-mono uppercase tracking-wider">
              <Clock className="w-4 h-4 text-accent/80" />
              <span>Next execution in <span className="font-mono text-white/90 bg-accent/10 px-2 py-0.5 rounded border border-accent/20">{nextExecution}</span></span>
            </div>
          </div>
        </div>

        {/* Timeline Log */}
        <div className="md:w-2/3 glass-light rounded-3xl p-6 md:p-10 anim relative overflow-hidden group hover:border-white/20 transition-all duration-500 hover:shadow-[0_0_40px_rgba(255,255,255,0.03)]" style={{ '--d': '0.2s' } as React.CSSProperties}>
          <BorderTrail size={300} className="bg-white/20" style={{ boxShadow: '0 0 40px 10px rgba(255,255,255,0.1)' }} />
          <div className="absolute top-0 right-0 w-full h-full bg-gradient-to-b from-white/5 to-transparent pointer-events-none opacity-50"></div>
          
          <div className="space-y-8 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-px before:bg-gradient-to-b before:from-transparent before:via-white/15 before:to-transparent z-10">
            {mockLogs.map((log) => (
              <div key={log.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group/item is-active">
                {/* Timeline dot */}
                <div className="flex items-center justify-center w-10 h-10 rounded-full border border-white/10 bg-black/80 glass-light text-muted group-hover/item:text-shield-green group-hover/item:border-shield-green/30 group-hover/item:shadow-[0_0_20px_rgba(74,222,128,0.15)] transition-all duration-300 shrink-0 md:order-1 md:group-odd/item:-translate-x-1/2 md:group-even/item:translate-x-1/2 shadow-xl z-10">
                  <Activity className="w-4 h-4" />
                </div>
                
                {/* Content */}
                <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] bg-black/40 p-5 rounded-2xl border border-white/5 group-hover/item:bg-white/[0.04] group-hover/item:border-white/10 transition-all duration-300 shadow-inner">
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <time className="text-[11px] text-muted font-mono uppercase tracking-wider">
                        {new Date(log.timestamp).toLocaleString(undefined, { 
                          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                        })}
                      </time>
                      <div className="flex items-center gap-1.5 text-[10px] text-shield-green font-mono uppercase tracking-wider bg-shield-green/10 px-2.5 py-1 rounded-md border border-shield-green/20 shadow-inner">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Attested
                      </div>
                    </div>
                    
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-sm font-medium text-white/90">Rebalance Executed</span>
                      <a href={`https://etherscan.io/tx/${log.txHash}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11px] text-accent/80 hover:text-accent font-mono tracking-wider transition-colors">
                        {log.txHash} <ArrowRight className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

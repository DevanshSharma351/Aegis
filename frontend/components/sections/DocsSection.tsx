'use client';

import React from 'react';
import { BookOpen, ShieldCheck, Database, Zap, HardDrive } from 'lucide-react';

export function DocsSection() {
  return (
    <section id="docs" className="w-full max-w-4xl mx-auto py-24 px-6 relative z-10 border-t border-white/5">
      <div className="mb-12 text-center anim" style={{ '--d': '0.1s' } as React.CSSProperties}>
        <h2 className="text-3xl md:text-5xl font-display mb-4 tracking-tighter bg-gradient-to-br from-white to-white/40 bg-clip-text text-transparent">Architecture & Trust Model</h2>
        <p className="text-muted max-w-2xl mx-auto text-sm md:text-base leading-relaxed">
          How Aegis ensures privacy, verifiable execution, and non-custodial operations without a central point of failure.
        </p>
      </div>

      <div className="space-y-6">
        {/* Step 1 */}
        <div className="glass-light p-8 rounded-3xl anim flex flex-col md:flex-row gap-6 items-start relative overflow-hidden group hover:border-white/20 transition-all duration-500 hover:shadow-[0_0_40px_rgba(74,222,128,0.05)]" style={{ '--d': '0.2s' } as React.CSSProperties}>
          <div className="absolute top-0 right-0 w-64 h-64 bg-shield-green/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>
          
          <div className="w-14 h-14 rounded-2xl bg-shield-green/10 flex items-center justify-center border border-shield-green/20 shrink-0 shadow-[0_0_15px_rgba(74,222,128,0.15)] relative z-10">
            <HardDrive className="text-shield-green w-7 h-7" />
          </div>
          <div className="relative z-10">
            <h3 className="font-display tracking-wide text-xl mb-3 text-white/90">1. Hardware-Isolated Intel TDX Enclave</h3>
            <p className="text-muted text-[13px] leading-relaxed mb-4 font-mono tracking-wide">
              The core trading logic (deterministic signals plus a local SLM) runs inside an Intel TDX confidential VM via dstack/Phala, so the host cannot read the enclave&apos;s memory to front-run its decisions. Integrity is attested through the TD measurement registers — MRTD and RTMR0-2 — combined with the app-compose hash that pins the container images. That composite is the value AttestationVerifier enforces on-chain, so a rebuilt image cannot pass a stale measurement. (TDX measures a whole VM; MRENCLAVE is the SGX equivalent and does not apply here.)
            </p>
          </div>
        </div>

        {/* Step 2 */}
        <div className="glass-light p-8 rounded-3xl anim flex flex-col md:flex-row gap-6 items-start relative overflow-hidden group hover:border-white/20 transition-all duration-500 hover:shadow-[0_0_40px_rgba(255,255,255,0.05)]" style={{ '--d': '0.3s' } as React.CSSProperties}>
          <div className="absolute top-0 right-0 w-64 h-64 bg-accent/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>

          <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center border border-accent/20 shrink-0 shadow-[0_0_15px_rgba(255,255,255,0.15)] relative z-10">
            <ShieldCheck className="text-accent w-7 h-7" />
          </div>
          <div className="relative z-10">
            <h3 className="font-display tracking-wide text-xl mb-3 text-white/90">2. ERC-4337 Session Keys via ZeroDev</h3>
            <p className="text-muted text-[13px] leading-relaxed mb-4 font-mono tracking-wide">
              The agent holds an ephemeral session key, not the master funds. AegisVault configures this key with strict policies: maximum 1 trade per day, only to specific whitelisted DEX routers, and absolute zero withdrawal permissions. If the enclave is compromised, the attacker cannot drain the vault.
            </p>
          </div>
        </div>

        {/* Step 3 */}
        <div className="glass-light p-8 rounded-3xl anim flex flex-col md:flex-row gap-6 items-start relative overflow-hidden group hover:border-white/20 transition-all duration-500 hover:shadow-[0_0_40px_rgba(168,85,247,0.05)]" style={{ '--d': '0.4s' } as React.CSSProperties}>
          <div className="absolute top-0 right-0 w-64 h-64 bg-purple-500/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>

          <div className="w-14 h-14 rounded-2xl bg-purple-500/10 flex items-center justify-center border border-purple-500/20 shrink-0 shadow-[0_0_15px_rgba(168,85,247,0.15)] relative z-10">
            <Database className="text-purple-400 w-7 h-7" />
          </div>
          <div className="relative z-10">
            <h3 className="font-display tracking-wide text-xl mb-3 text-white/90">3. Shielded Execution via Railgun</h3>
            <p className="text-muted text-[13px] leading-relaxed mb-4 font-mono tracking-wide">
              Deposits and trades are routed exclusively through Railgun&apos;s 0zk pools. By keeping balances and trade sizes encrypted on-chain, Aegis prevents observers from copying the agent&apos;s alpha or calculating the fund&apos;s AUM. Only depositors holding their client-side viewing keys can decrypt their individual balances.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

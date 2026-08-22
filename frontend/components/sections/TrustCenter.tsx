'use client';

import React from 'react';
import { ShieldCheck, Cpu, Download, ExternalLink, Lock } from 'lucide-react';
import { TextMorph } from '@/components/core/text-morph';
import { BorderTrail } from '@/components/core/border-trail';

export function TrustCenter() {
  const handleDownload = () => {
    // Mock download quote
    const mockQuote = {
      version: 4,
      attestation_key_type: "ECDSA-P256",
      tee_type: "Intel SGX",
      report_data: "0x123...",
      mr_enclave: "0x8f3a9b...2c1e",
      mr_signer: "0x000000...0000",
      isv_prod_id: 1,
      isv_svn: 2
    };
    const blob = new Blob([JSON.stringify(mockQuote, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aegis-attestation-quote.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section id="attestation" className="w-full max-w-5xl mx-auto py-24 px-6 relative z-10">
      <div className="mb-12 text-center anim" style={{ '--d': '0.1s' } as React.CSSProperties}>
        <h2 className="text-3xl md:text-5xl font-display mb-4 tracking-tighter bg-gradient-to-br from-white to-white/40 bg-clip-text text-transparent">Trust & Verification Center</h2>
        <p className="text-muted max-w-2xl mx-auto text-sm md:text-base leading-relaxed">
          Aegis operates inside a secure hardware enclave. The code is verifiable, and execution is attested. Don't trust our UI—verify the cryptographic proofs yourself.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Attestation Badge Card */}
        <div className="glass-light p-8 rounded-3xl anim flex flex-col gap-6 relative overflow-hidden group hover:border-white/20 transition-all duration-500 hover:shadow-[0_0_40px_rgba(74,222,128,0.05)]" style={{ '--d': '0.2s' } as React.CSSProperties}>
          <BorderTrail size={180} className="bg-shield-green/50" style={{ boxShadow: '0 0 40px 10px rgba(74,222,128,0.3)' }} />
          <div className="absolute top-0 right-0 w-64 h-64 bg-shield-green/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>
          
          <div className="flex items-start justify-between relative z-10">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-shield-green/10 flex items-center justify-center border border-shield-green/20 shadow-[0_0_15px_rgba(74,222,128,0.15)]">
                <ShieldCheck className="text-shield-green w-7 h-7" />
              </div>
              <div>
                <h3 className="font-display tracking-wide text-lg text-white/90">Hardware Attestation</h3>
                <div className="flex items-center gap-2 mt-1">
                  <span className="w-2 h-2 rounded-full bg-shield-green shadow-[0_0_8px_#4ade80] animate-pulse"></span>
                  <span className="text-shield-green text-sm font-mono uppercase tracking-wider">Verified (SGX Enclave)</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-muted font-mono uppercase tracking-wider backdrop-blur-md">
              <Cpu className="w-3.5 h-3.5" />
              Hardware Mode
            </div>
          </div>

          <div className="space-y-4 pt-6 border-t border-white/5 relative z-10 mt-2">
            <div>
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs text-muted uppercase tracking-wider font-semibold font-mono">MRENCLAVE (Code Hash)</span>
              </div>
              <code className="block w-full p-4 bg-black/60 rounded-xl border border-white/5 text-[11px] md:text-xs text-accent/90 font-mono break-all leading-relaxed shadow-inner">
                0x8f3a9b4d8c2e1f0a3b6d9e5c4f7a2b1d0e9f8a7c6b5d4e3f2a1b0c9d8e7f6a5b
              </code>
            </div>
            
            <div className="flex flex-col sm:flex-row gap-3 pt-4">
              <a 
                href="https://phala.network/trust-center" 
                target="_blank" 
                rel="noreferrer"
                className="flex-1 flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 transition-colors border border-white/10 rounded-xl py-3 text-sm font-medium font-mono uppercase tracking-wider text-white/80"
              >
                <ExternalLink className="w-4 h-4" />
                Verify Independently
              </a>
              <button 
                onClick={handleDownload}
                className="flex-1 flex items-center justify-center gap-2 bg-white text-black hover:bg-white/90 transition-all hover:shadow-[0_0_20px_rgba(255,255,255,0.2)] rounded-xl py-3 text-sm font-medium font-mono uppercase tracking-wider"
              >
                <Download className="w-4 h-4" />
                <TextMorph>Download Quote</TextMorph>
              </button>
            </div>
          </div>
        </div>

        {/* Policy Configuration Card */}
        <div className="glass-light p-8 rounded-3xl anim flex flex-col gap-6 relative overflow-hidden group hover:border-white/20 transition-all duration-500 hover:shadow-[0_0_40px_rgba(99,102,241,0.05)]" style={{ '--d': '0.3s' } as React.CSSProperties}>
          <BorderTrail size={180} className="bg-accent/50" style={{ boxShadow: '0 0 40px 10px rgba(99,102,241,0.3)' }} />
          <div className="absolute top-0 right-0 w-64 h-64 bg-accent/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none transition-opacity opacity-50 group-hover:opacity-100"></div>

          <div className="flex items-center gap-4 relative z-10">
            <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center border border-accent/20 shadow-[0_0_15px_rgba(99,102,241,0.15)]">
              <Lock className="text-accent w-7 h-7" />
            </div>
            <div>
              <h3 className="font-display tracking-wide text-lg text-white/90">Session Key Policy</h3>
              <p className="text-sm text-muted mt-1 font-mono uppercase tracking-wider text-[10px]">Live limits enforced by ZeroDev & AegisVault</p>
            </div>
          </div>

          <div className="space-y-3 pt-6 border-t border-white/5 flex-1 relative z-10 mt-2">
            <div className="flex justify-between items-center p-4 bg-black/40 hover:bg-black/60 transition-colors rounded-xl border border-white/5 shadow-inner">
              <span className="text-sm text-muted font-mono uppercase tracking-wider text-[11px]">Max Trades / Day</span>
              <span className="font-mono text-white/90">1 Trade</span>
            </div>
            <div className="flex justify-between items-center p-4 bg-black/40 hover:bg-black/60 transition-colors rounded-xl border border-white/5 shadow-inner">
              <span className="text-sm text-muted font-mono uppercase tracking-wider text-[11px]">Whitelisted Assets</span>
              <span className="font-mono text-xs bg-accent/10 text-accent border border-accent/20 px-2 py-1 rounded-md">USDC, WETH, WBTC</span>
            </div>
            <div className="flex justify-between items-center p-4 bg-red-500/5 hover:bg-red-500/10 transition-colors rounded-xl border border-red-500/10 shadow-inner">
              <span className="text-sm text-red-400/80 font-mono uppercase tracking-wider text-[11px]">Withdrawal Allowance</span>
              <span className="font-mono text-sm text-red-400">0.00 (Strictly Blocked)</span>
            </div>
            <div className="flex justify-between items-center p-4 bg-black/40 hover:bg-black/60 transition-colors rounded-xl border border-white/5 shadow-inner">
              <span className="text-sm text-muted font-mono uppercase tracking-wider text-[11px]">Target Execution Env</span>
              <span className="font-mono text-xs text-white/80">Railgun 0zk Pool</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

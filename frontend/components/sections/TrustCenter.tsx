'use client';

import React from 'react';
import { ShieldCheck, ShieldAlert, Cpu, Download, ExternalLink, Lock, Loader2 } from 'lucide-react';
import { TextMorph } from '@/components/core/text-morph';
import { BorderTrail } from '@/components/core/border-trail';

import { useAttestationStatus, attestationSourceLabel } from '@/lib/hooks/useAttestationStatus';
import { useSessionKeyPolicy } from '@/lib/hooks/useSessionKeyPolicy';
import { ADDRESSES, explorerAddress, truncateHash } from '@/lib/contracts';

/**
 * Trust & Verification Center — every value here is read live from Sepolia.
 *
 * The previous version of this component hardcoded "Verified (SGX Enclave)",
 * "Hardware Mode", a fabricated MRENCLAVE, a whitelist including WBTC, and a
 * downloadable JSON claiming to be an Intel SGX quote. None of that was true:
 * this deployment attests through the dstack TDX *simulator*, holds only WETH
 * and USDC, and its measurement is a keccak over TDX registers, not an
 * MRENCLAVE.
 *
 * A page whose entire pitch is "don't trust our UI, verify the proofs" cannot
 * display invented proofs. Where a value is not verifiable, this component says
 * so rather than substituting a plausible one.
 */
export function TrustCenter() {
  const attestation = useAttestationStatus();
  const policy = useSessionKeyPolicy();

  const isHardware = attestation.source === 'hardware-tdx';
  const measurementOk = attestation.matches === true;

  // Green is reserved for "hardware-attested AND the on-chain measurement
  // matches this build". Anything else is amber, because a simulator quote
  // proves the pipeline works and nothing about hardware.
  const verified = isHardware && measurementOk;

  const statusLine = attestation.isLoading
    ? 'Reading contract…'
    : attestation.error
      ? 'Verifier unreachable'
      : measurementOk
        ? `Measurement matches (${attestationSourceLabel(attestation.source)})`
        : 'Measurement MISMATCH — enclave rebuilt without rotation';

  /**
   * Download the measurement record actually in force.
   *
   * Not a synthesised "quote": the real TDX quote is ~5 KB of binary produced
   * per decision inside the enclave and is not something the browser holds. What
   * the frontend can honestly hand over is the on-chain constant, its
   * provenance, and where to check it — so that is what this exports.
   */
  const handleDownload = () => {
    const record = {
      note: 'On-chain attestation configuration for Aegis. This is NOT a TDX quote — quotes are produced per decision inside the enclave and verified off-chain by the oracle before signing.',
      chain: 'ethereum-sepolia',
      attestationVerifier: ADDRESSES.attestationVerifier,
      aegisVault: ADDRESSES.aegisVault,
      oracleSigner: ADDRESSES.oracleSigner,
      expectedMeasurementOnChain: attestation.onChainMeasurement,
      measurementThisBuildExpects: attestation.expectedMeasurement,
      measurementsMatch: attestation.matches,
      attestationSource: attestation.source,
      measurementDerivation:
        'keccak256("AegisEnclaveMeasurement:v1" || mrtd || rtmr0 || rtmr1 || rtmr2 || composeHash)',
      verifyYourself: `${explorerAddress(ADDRESSES.attestationVerifier)}#readContract`,
      retrievedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aegis-attestation-record.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section id="attestation" className="w-full max-w-5xl mx-auto py-24 px-6 relative z-10">
      <div className="mb-12 text-center anim" style={{ '--d': '0.1s' } as React.CSSProperties}>
        <h2 className="text-3xl md:text-5xl font-display mb-4 tracking-tighter bg-gradient-to-br from-white to-white/40 bg-clip-text text-transparent">
          Trust &amp; Verification Center
        </h2>
        <p className="text-muted max-w-2xl mx-auto text-sm md:text-base leading-relaxed">
          Aegis reasons inside a hardware-isolated enclave and proves what it decided on-chain.
          Every value on this page is read live from Sepolia — don&apos;t trust this UI, verify it yourself.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* ---------------------------------------------------------------- */}
        {/* Attestation */}
        {/* ---------------------------------------------------------------- */}
        <div
          className="glass-light p-8 rounded-3xl anim flex flex-col gap-6 relative overflow-hidden group hover:border-white/20 transition-all duration-500"
          style={{ '--d': '0.2s' } as React.CSSProperties}
        >
          <BorderTrail
            size={180}
            className={verified ? 'bg-shield-green/50' : 'bg-amber-400/50'}
            style={{
              boxShadow: verified
                ? '0 0 40px 10px rgba(74,222,128,0.3)'
                : '0 0 40px 10px rgba(251,191,36,0.25)',
            }}
          />

          <div className="flex items-start justify-between relative z-10">
            <div className="flex items-center gap-4">
              <div
                className={`w-14 h-14 rounded-2xl flex items-center justify-center border ${
                  verified
                    ? 'bg-shield-green/10 border-shield-green/20'
                    : 'bg-amber-400/10 border-amber-400/20'
                }`}
              >
                {attestation.isLoading ? (
                  <Loader2 className="w-7 h-7 animate-spin text-white/50" />
                ) : verified ? (
                  <ShieldCheck className="text-shield-green w-7 h-7" />
                ) : (
                  <ShieldAlert className="text-amber-400 w-7 h-7" />
                )}
              </div>
              <div>
                <h3 className="font-display tracking-wide text-lg text-white/90">TEE Attestation</h3>
                <div className="flex items-center gap-2 mt-1">
                  <span
                    className={`w-2 h-2 rounded-full animate-pulse ${
                      verified ? 'bg-shield-green' : 'bg-amber-400'
                    }`}
                  />
                  <span
                    className={`text-sm font-mono uppercase tracking-wider ${
                      verified ? 'text-shield-green' : 'text-amber-400'
                    }`}
                  >
                    {statusLine}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-muted font-mono uppercase tracking-wider backdrop-blur-md shrink-0">
              <Cpu className="w-3.5 h-3.5" />
              {attestationSourceLabel(attestation.source)}
            </div>
          </div>

          {/* The honesty disclosure. Shown whenever this is not real hardware. */}
          {!isHardware && !attestation.isLoading && (
            <div className="relative z-10 rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-[12px] leading-relaxed text-amber-200/80">
              <strong className="font-semibold text-amber-300">Simulator attestation.</strong>{' '}
              Quotes come from the dstack simulator, not Intel-signed TDX hardware. The full
              verification chain still runs — the decision hash is bound into the quote&apos;s
              report_data, the event log is replayed against the attested RTMRs, and the measurement
              is derived from the quote itself — but none of it proves the code ran on real hardware.
            </div>
          )}

          <div className="space-y-4 pt-6 border-t border-white/5 relative z-10 mt-2">
            <div>
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs text-muted uppercase tracking-wider font-semibold font-mono">
                  Enclave Measurement (on-chain)
                </span>
              </div>
              <code className="block w-full p-4 bg-black/60 rounded-xl border border-white/5 text-[11px] md:text-xs text-accent/90 font-mono break-all leading-relaxed shadow-inner">
                {attestation.isLoading
                  ? 'reading AttestationVerifier.expectedMeasurement()…'
                  : (attestation.onChainMeasurement ?? attestation.error ?? 'unavailable')}
              </code>
              <p className="mt-2 text-[10px] text-muted font-mono leading-relaxed">
                keccak256(&quot;AegisEnclaveMeasurement:v1&quot; ‖ mrtd ‖ rtmr0 ‖ rtmr1 ‖ rtmr2 ‖ composeHash)
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 pt-4">
              <a
                href={`${explorerAddress(ADDRESSES.attestationVerifier)}#readContract`}
                target="_blank"
                rel="noreferrer"
                className="flex-1 flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 transition-colors border border-white/10 rounded-xl py-3 text-sm font-medium font-mono uppercase tracking-wider text-white/80"
              >
                <ExternalLink className="w-4 h-4" />
                Verify On Etherscan
              </a>
              <button
                onClick={handleDownload}
                disabled={attestation.isLoading}
                className="flex-1 flex items-center justify-center gap-2 bg-white text-black hover:bg-white/90 disabled:opacity-40 transition-all rounded-xl py-3 text-sm font-medium font-mono uppercase tracking-wider"
              >
                <Download className="w-4 h-4" />
                <TextMorph>Export Record</TextMorph>
              </button>
            </div>
          </div>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Session key policy */}
        {/* ---------------------------------------------------------------- */}
        <div
          className="glass-light p-8 rounded-3xl anim flex flex-col gap-6 relative overflow-hidden group hover:border-white/20 transition-all duration-500"
          style={{ '--d': '0.3s' } as React.CSSProperties}
        >
          <BorderTrail
            size={180}
            className="bg-accent/50"
            style={{ boxShadow: '0 0 40px 10px rgba(99,102,241,0.3)' }}
          />

          <div className="flex items-center gap-4 relative z-10">
            <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center border border-accent/20">
              <Lock className="text-accent w-7 h-7" />
            </div>
            <div>
              <h3 className="font-display tracking-wide text-lg text-white/90">Session Key Policy</h3>
              <p className="text-sm text-muted mt-1 font-mono uppercase tracking-wider text-[10px]">
                Enforced by the Kernel validator &amp; AegisVault
              </p>
            </div>
          </div>

          <div className="space-y-3 pt-6 border-t border-white/5 flex-1 relative z-10 mt-2">
            <PolicyRow
              label="Max Executions / Day"
              value={policy.isLoading ? '…' : String(policy.maxExecutionsPerDay)}
            />
            <PolicyRow
              label="Whitelisted Assets"
              value={
                policy.isLoading
                  ? '…'
                  : policy.whitelistedAssets.map((a) => a.symbol).join(', ')
              }
              accent
            />
            <PolicyRow
              label="Callable Function"
              value={policy.isLoading ? '…' : policy.allowedSignature}
              mono
            />
            <PolicyRow
              label="Native Value Limit"
              value={`${policy.valueLimitWei} wei`}
            />

            {/* The strongest guarantee, derived from the compiled ABI rather
                than asserted: no function in the vault can move value. */}
            <div className="flex justify-between items-center p-4 bg-red-500/5 rounded-xl border border-red-500/10 shadow-inner">
              <span className="text-sm text-red-400/80 font-mono uppercase tracking-wider text-[11px]">
                Withdrawal Functions
              </span>
              <span className="font-mono text-sm text-red-400">
                {policy.hasNoWithdrawalFunction ? '0 — none exist in the ABI' : 'PRESENT'}
              </span>
            </div>

            <PolicyRow
              label="Executing Account"
              value={
                policy.isLoading
                  ? '…'
                  : policy.sessionKeyBound
                    ? truncateHash(policy.sessionKeyAddress ?? '', 8, 6)
                    : 'not bound'
              }
              mono
            />
          </div>

          {policy.error && (
            <p className="relative z-10 text-[11px] text-red-400/70 font-mono">{policy.error}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function PolicyRow({
  label,
  value,
  accent = false,
  mono = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between items-center gap-4 p-4 bg-black/40 hover:bg-black/60 transition-colors rounded-xl border border-white/5 shadow-inner">
      <span className="text-sm text-muted font-mono uppercase tracking-wider text-[11px] shrink-0">
        {label}
      </span>
      <span
        className={
          accent
            ? 'font-mono text-xs bg-accent/10 text-accent border border-accent/20 px-2 py-1 rounded-md text-right'
            : `text-white/90 text-right ${mono ? 'font-mono text-xs' : 'font-mono'}`
        }
      >
        {value}
      </span>
    </div>
  );
}

'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';

// Mock owner address for demo purposes. In production, this would be fetched from the contract.
const VAULT_OWNER = '0x1234567890123456789012345678901234567890'; // Replace with actual address or useReadContract

export function WalletHeader() {
  const { address, isConnected } = useAccount();

  // Simple role detection
  const isOwner = address?.toLowerCase() === VAULT_OWNER.toLowerCase();
  const role = isConnected ? (isOwner ? 'Admin' : 'Depositor') : 'Visitor';

  return (
    <div className="absolute top-0 w-full z-50 px-6 py-6 flex justify-between items-center pointer-events-auto">
      <div className="flex items-center gap-4">
        {isConnected && (
          <div className="px-3 py-1 rounded-full bg-black/40 border border-white/10 backdrop-blur-md text-xs text-white/80 font-medium">
            Role: <span className={isOwner ? "text-accent" : "text-shield-green"}>{role}</span>
          </div>
        )}
      </div>
      <div>
        <ConnectButton 
          chainStatus="none"
          showBalance={false}
        />
      </div>
    </div>
  );
}

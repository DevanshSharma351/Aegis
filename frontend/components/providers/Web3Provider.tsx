'use client';

import '@rainbow-me/rainbowkit/styles.css';

import {
  darkTheme,
  getDefaultConfig,
  RainbowKitProvider,
} from '@rainbow-me/rainbowkit';
import {
  coinbaseWallet,
  injectedWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { WagmiProvider } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import {
  QueryClientProvider,
  QueryClient,
} from '@tanstack/react-query';

const config = getDefaultConfig({
  appName: 'Aegis',
  projectId: 'fe3a58f3a1bab358ae25e918ce3aa2f6',
  // Sepolia only. The vault, verifier, and Railgun pool this app reads are all
  // deployed there, so offering other chains in the connect modal would let a
  // user connect to a network on which every read returns nothing.
  chains: [sepolia],
  ssr: true,
  wallets: [
    {
      groupName: 'Recommended',
      wallets: [injectedWallet, coinbaseWallet],
    },
  ],
});

const queryClient = new QueryClient();

export function Web3Provider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme({
          accentColor: '#e8e8ea',
          accentColorForeground: '#0a0a0a',
          borderRadius: 'medium',
          fontStack: 'system',
          overlayBlur: 'small',
        })}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

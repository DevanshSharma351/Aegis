'use client';

import '@rainbow-me/rainbowkit/styles.css';

import {
  darkTheme,
  getDefaultConfig,
  RainbowKitProvider,
} from '@rainbow-me/rainbowkit';
import {
  metaMaskWallet,
  coinbaseWallet,
  injectedWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { WagmiProvider } from 'wagmi';
import {
  mainnet,
  polygon,
  optimism,
  arbitrum,
  base,
} from 'wagmi/chains';
import {
  QueryClientProvider,
  QueryClient,
} from '@tanstack/react-query';

const config = getDefaultConfig({
  appName: 'Aegis',
  projectId: '3a8170812b534d0f3e1a8a0f8b8e0b68', // Keep placeholder, it won't be used
  chains: [mainnet, polygon, optimism, arbitrum, base],
  ssr: true,
  wallets: [
    {
      groupName: 'Recommended',
      wallets: [metaMaskWallet, coinbaseWallet, injectedWallet],
    },
  ],
});

const queryClient = new QueryClient();

export function Web3Provider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme({
          accentColor: '#6366f1',
          accentColorForeground: 'white',
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

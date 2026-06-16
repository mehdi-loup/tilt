"use client";

import { PrivyProvider } from "@privy-io/react-auth";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#c8f56b",
          logo: undefined,
        },
        // Don't auto-provision an embedded wallet on login — users fund from
        // their connected external wallet. The modal still creates one on
        // demand (useCreateWallet) for users without an external wallet.
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}

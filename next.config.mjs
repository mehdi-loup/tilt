/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // Privy's bundle references an optional Farcaster/Solana mini-app shim we don't use.
    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      "@farcaster/mini-app-solana": false,
    };
    return config;
  },
};
export default nextConfig;

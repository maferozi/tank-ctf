import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The shared package ships TypeScript source, so Next compiles it.
  transpilePackages: ["@tank/shared"],
  // Hide the floating "N" dev badge so the game has the whole screen.
  devIndicators: false,
};

export default nextConfig;

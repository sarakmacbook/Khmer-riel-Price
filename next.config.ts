import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Heavy native/optional-dependency DB drivers are loaded from node_modules
  // at runtime instead of being bundled — the mongodb store imports the
  // driver lazily, so it's only ever required when MONGODB_URI is set.
  serverExternalPackages: ["mongodb"],
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static export: no server. The output folder is published to Swarm and
  // resolved through an ENS name's contenthash.
  output: "export",
  // Every route becomes <route>/index.html, which a Swarm manifest serves as a
  // directory index.
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  // Next only inlines NEXT_PUBLIC_* values that are defined at build time. Defining the dev wallet key as ""
  // when unset makes `if (process.env.NEXT_PUBLIC_DEV_WALLET_KEY)` a constant false, so the bundler drops
  // the wallet module from every normal build.
  env: { NEXT_PUBLIC_DEV_WALLET_KEY: process.env.NEXT_PUBLIC_DEV_WALLET_KEY ?? "" },
  // `*.dev.tsx` pages (the dev wallet helper) exist only in the `pnpm dev:up` stack: without the dev
  // wallet key they are not routes, so a published export has no /dev-wallet page or reserved label.
  pageExtensions: process.env.NEXT_PUBLIC_DEV_WALLET_KEY ? ["tsx", "ts", "jsx", "js", "dev.tsx"] : ["tsx", "ts", "jsx", "js"],
  reactStrictMode: true,
  // Intentionally no basePath / assetPrefix: both bake an absolute prefix into the
  // build, so the same output could not be served under /bzz/<hash>/, on a bzz
  // subdomain and at an ENS gateway root at once. scripts/postexport.mjs rewrites
  // the emitted HTML and webpack runtime to hash-agnostic relative URLs instead.
  // Workspace packages ship TypeScript sources with `.js` import specifiers.
  transpilePackages: ["@varada/sdk", "@varada/ui"],
  webpack(config) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;

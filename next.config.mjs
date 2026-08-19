/** @type {import('next').NextConfig} */
const nextConfig = {
  // Snapshots are committed; no build-time indexing step (BUILD.md §6).
  //
  // loadSnapshot() reads snapshots/<repo>.json at RUNTIME via a computed path,
  // which Next's static file tracing cannot see. Without this include the
  // serverless bundle omits them and every route ENOENTs on Vercel while working
  // fine locally. Trace them explicitly.
  outputFileTracingIncludes: {
    "/api/pack": ["./snapshots/*.json"],
    "/api/step": ["./snapshots/*.json"],
    "/api/tool": ["./snapshots/*.json"],
  },
};

export default nextConfig;

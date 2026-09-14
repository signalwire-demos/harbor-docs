/**
 * Runtime config endpoint for the DocsBot / Quincy widget.
 *
 * Returns the agent URL from the Pages Function's env binding, which Cloudflare
 * populates at runtime from the dashboard's Variables and Secrets. This is a
 * different code path than Astro's build-time `import.meta.env.PUBLIC_*`
 * inlining, and that distinction is the whole point:
 *
 * `PUBLIC_DOCSBOT_AGENT_URL` lives in a local `.env` that points at an ngrok
 * tunnel during development. Baking that value into a production build is what
 * left the deployed site calling a dead tunnel on a laptop. Resolving the URL
 * here instead means the dev-only value can no longer reach production, and
 * swapping the agent URL is a dashboard edit rather than a rebuild.
 *
 * Precedence lives in DocsBotWidget.tsx: a build-time value wins when present
 * (the local-dev fast path), and this endpoint is consulted when it's absent.
 * So production builds must deliberately NOT set PUBLIC_DOCSBOT_AGENT_URL —
 * see .github/workflows/deploy.yml.
 *
 */

interface Env {
  PUBLIC_DOCSBOT_AGENT_URL?: string;
}

export const onRequestGet: PagesFunction<Env> = ({ env }) => {
  return new Response(
    JSON.stringify({ agentUrl: env.PUBLIC_DOCSBOT_AGENT_URL || "" }),
    {
      headers: {
        "Content-Type": "application/json",
        // The whole value of runtime resolution is that a changed agent URL
        // takes effect on the next page load. Caching this would undo that.
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    },
  );
};

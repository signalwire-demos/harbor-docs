// /api/product.schema.json — serves product.schema.json for the agent.
//
// Convenience: keeps the canonical schema at the repo root while still exposing
// it under a clean URL. The agent fetches this for structural lookups ("what
// endpoints exist?") without having to RAG through the MDX.

import type { APIRoute } from 'astro';
import schema from '../../../product.schema.json';

export const prerender = true;

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify(schema, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
};

# Harbor docs, with a voice agent in the page

Harbor is a fictional webhook-delivery product. This repository is its
documentation site, built with Astro and Starlight, and it exists to
demonstrate one thing: a SignalWire voice agent embedded in a web page that
knows which page the visitor is reading.

The site is live at https://harbor-docs-5k2.pages.dev/. The recipe that
explains the mechanism is on SignalWire Recipes:
https://signalwire.com/developers/demos/r/embed-a-state-aware-voice-agent-in-your-web-page.html

## What is in here

- `src/content/docs/` is the documentation corpus. Most pages are generated
  from `product.schema.json` by `scripts/seed-docs.mjs`; see `scripts/README.md`.
- `src/components/DocsBotWidget.tsx` is the voice widget. It loads the
  SignalWire Browser SDK from `public/signalwire.js`, fetches a token from the
  agent, dials it, and reports the current page so the agent can answer about
  what the visitor is looking at.
- `src/components/DocsBotAside.tsx` is the drawer the agent opens when it pins
  a page for the visitor.
- `functions/api/docsbot-config.json.ts` is a Cloudflare Pages Function that
  hands the widget the agent URL at runtime, so the URL is a dashboard setting
  rather than a value baked into the build.
- `src/pages/api/` exposes the corpus as JSON and raw Markdown, which is what
  the agent's knowledge base is loaded from.

The agent itself is a SignalWire AI Agents SDK application and is not in this
repository. The widget only needs its URL.

## Run it

```bash
npm install
cp .env.example .env      # set PUBLIC_DOCSBOT_AGENT_URL to your agent
npm run dev               # http://localhost:4321
```

Without an agent URL the site works as plain documentation and the widget
reports that no agent is configured.

`npm run build` writes `dist/`. Deployment is Cloudflare Pages through
`.github/workflows/deploy.yml`; the agent URL for the deployed site is set in
the Pages dashboard, never in the workflow, for the reason the workflow's
comments give.

## License

MIT. See `LICENSE`.

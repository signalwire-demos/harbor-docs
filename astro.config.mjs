// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  site: 'https://harbor.example',
  integrations: [
    starlight({
      title: 'Harbor',
      description: 'Reliable webhook delivery, with guardrails.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/harbor-demo/harbor' },
      ],
      // Override the default Footer to mount the DocsBot voice widget.
      // The widget uses position: fixed + transition:persist, so the Footer
      // is just the mount point — the widget floats independently.
      components: {
        // Head override injects <ClientRouter /> so Astro view transitions
        // are enabled site-wide. Required for transition:persist on the
        // DocsBot widget — without it, client nav does a full reload and
        // the widget (and active call) gets torn down.
        Head: './src/components/DocsBotHead.astro',
        Footer: './src/components/DocsBotFooter.astro',
        // Custom editorial hero for the splash page.
        Hero: './src/components/HarborHero.astro',
      },
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Install', slug: 'getting-started/install' },
            { label: 'Quickstart', slug: 'getting-started/quickstart' },
          ],
        },
        {
          label: 'Core concepts',
          items: [
            { label: 'Destinations', slug: 'concepts/destinations' },
            { label: 'Subscriptions', slug: 'concepts/subscriptions' },
            { label: 'Events', slug: 'concepts/events' },
            { label: 'Deliveries', slug: 'concepts/deliveries' },
            { label: 'Signing & verification', slug: 'concepts/signing-verification' },
            { label: 'Idempotency', slug: 'concepts/idempotency' },
            { label: 'Retry policy', slug: 'concepts/retry-policy' },
            { label: 'Dead-letter queue', slug: 'concepts/dead-letter-queue' },
            { label: 'Event types', slug: 'concepts/event-types' },
          ],
        },
        {
          label: 'API reference',
          items: [
            { label: 'Destinations', slug: 'api/destinations' },
            { label: 'Subscriptions', slug: 'api/subscriptions' },
            { label: 'Events', slug: 'api/events' },
            { label: 'Deliveries', slug: 'api/deliveries' },
            { label: 'Signing keys', slug: 'api/signing-keys' },
            { label: 'Dead-letter queue', slug: 'api/dead-letter-queue' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Verifying signatures', slug: 'guides/verifying-signatures' },
            { label: 'Handling retries', slug: 'guides/handling-retries' },
            { label: 'Idempotent consumers', slug: 'guides/idempotent-consumers' },
            { label: 'Replaying events', slug: 'guides/replaying-events' },
            { label: 'Local testing', slug: 'guides/local-testing' },
          ],
        },
        {
          label: 'Troubleshooting',
          collapsed: true,
          items: [
            { label: 'HMAC signature mismatch', slug: 'troubleshooting/hmac-signature-mismatch' },
            { label: 'All deliveries failing', slug: 'troubleshooting/all-deliveries-failing' },
            { label: 'Retry storms', slug: 'troubleshooting/retry-storms' },
            { label: 'Clock drift', slug: 'troubleshooting/clock-drift' },
            { label: 'Duplicate events', slug: 'troubleshooting/duplicate-events' },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [
            { label: 'Errors', slug: 'reference/errors' },
            { label: 'Rate limits', slug: 'reference/rate-limits' },
            { label: 'Webhook spec', slug: 'reference/webhooks-spec' },
          ],
        },
      ],
      customCss: [
        './src/styles/harbor.css',
      ],
    }),
    react(),
  ],
});

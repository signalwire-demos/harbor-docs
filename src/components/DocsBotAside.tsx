// DocsBotAside.tsx — split-view "pin-to-side" drawer.
//
// Responds to two CustomEvents dispatched by DocsBotWidget (which in turn
// receives them from the agent via swml_user_event):
//
//   docsbot:pin_aside   { slug, path, title }  → open the drawer with that page
//   docsbot:close_aside {}                      → close the drawer
//
// Fetches the target page's rendered HTML, extracts its Starlight markdown
// content, and injects it into a right-side drawer. Sets a body data attr
// (`data-docsbot-aside`) that global CSS uses to shift the primary content
// left so the drawer doesn't occlude it.
//
// Owns its own open/closed state. Widget separately listens for the same
// events to mirror the slug/title into its /page_state POSTs so the agent's
// `current_page_block` reflects both pages.
//
// Gracefully no-ops during SSR (window/document guarded).

import { useCallback, useEffect, useState } from "react";
import "./DocsBotAside.css";

type AsidePage = {
  slug: string;
  path: string;
  title: string;
  bodyHtml: string; // innerHTML of .sl-markdown-content from the fetched page
};

// Starlight renders MDX into <div class="sl-markdown-content"> inside a
// <main> element. Extract JUST that so the aside doesn't duplicate the
// sidebar, header, or TOC.
function extractMarkdownBody(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const el = doc.querySelector(".sl-markdown-content");
    if (el) return el.innerHTML;
    // Fallback: grab <main> if the Starlight class ever changes.
    const main = doc.querySelector("main");
    return main?.innerHTML ?? "";
  } catch {
    return "";
  }
}

async function fetchPageBody(path: string): Promise<string> {
  // Defensive: path should always start with '/'. If it doesn't, coerce.
  const url = path.startsWith("/") ? path : `/${path}`;
  const resp = await fetch(url, { credentials: "same-origin" });
  if (!resp.ok) {
    throw new Error(`fetch ${url}: ${resp.status}`);
  }
  const html = await resp.text();
  return extractMarkdownBody(html);
}

export default function DocsBotAside() {
  const [page, setPage] = useState<AsidePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  const close = useCallback(() => {
    setPage(null);
    setLoading(false);
    setErr("");
    if (typeof document !== "undefined") {
      delete document.body.dataset.docsbotAside;
    }
  }, []);

  useEffect(() => {
    const onPin = (e: Event) => {
      if (e.defaultPrevented) return;
      const detail = (e as CustomEvent).detail as {
        slug?: string;
        path?: string;
        title?: string;
      };
      const slug = detail?.slug || "";
      const title = detail?.title || slug;
      const path =
        detail?.path || (slug ? `/${slug}/`.replace(/\/\/+/g, "/") : "");
      if (!path) return;

      // Open-with-placeholder-then-fill so the drawer appears immediately
      // (good perceived latency) and populates when the fetch resolves.
      document.body.dataset.docsbotAside = "open";
      setPage({ slug, path, title, bodyHtml: "" });
      setLoading(true);
      setErr("");

      void fetchPageBody(path)
        .then((bodyHtml) => {
          setPage((cur) =>
            cur && cur.slug === slug ? { ...cur, bodyHtml } : cur,
          );
          setLoading(false);
        })
        .catch((e) => {
          setLoading(false);
          setErr(
            e instanceof Error ? e.message : "Couldn't load the aside page.",
          );
        });
    };

    const onClose = (e: Event) => {
      if (e.defaultPrevented) return;
      close();
    };

    window.addEventListener("docsbot:pin_aside", onPin);
    window.addEventListener("docsbot:close_aside", onClose);
    return () => {
      window.removeEventListener("docsbot:pin_aside", onPin);
      window.removeEventListener("docsbot:close_aside", onClose);
    };
  }, [close]);

  // Close on Escape when open.
  useEffect(() => {
    if (!page) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Let the agent know the reader dismissed it.
        window.dispatchEvent(
          new CustomEvent("docsbot:aside_closed_by_user", { cancelable: true }),
        );
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, close]);

  if (!page) return null;

  return (
    <aside
      className="docsbot-aside"
      aria-label={`Pinned aside: ${page.title}`}
      data-state={loading ? "loading" : err ? "error" : "ready"}
    >
      <header className="docsbot-aside__header">
        <div>
          <div className="docsbot-aside__eyebrow">Pinned aside</div>
          <div className="docsbot-aside__title">{page.title}</div>
          <div className="docsbot-aside__path">{page.path}</div>
        </div>
        <button
          type="button"
          className="docsbot-aside__close"
          aria-label="Close aside"
          onClick={() => {
            // Signal "user closed this" so the widget can relay to the agent.
            window.dispatchEvent(
              new CustomEvent("docsbot:aside_closed_by_user", {
                cancelable: true,
              }),
            );
            close();
          }}
        >
          ✕
        </button>
      </header>
      <div className="docsbot-aside__body">
        {loading && (
          <div className="docsbot-aside__placeholder">
            Loading <code>{page.path}</code>…
          </div>
        )}
        {err && (
          <div className="docsbot-aside__error">
            Couldn't load that page. <small>{err}</small>
          </div>
        )}
        {!loading && !err && page.bodyHtml && (
          // eslint-disable-next-line react/no-danger
          <div
            className="sl-markdown-content docsbot-aside__content"
            dangerouslySetInnerHTML={{ __html: page.bodyHtml }}
          />
        )}
      </div>
    </aside>
  );
}

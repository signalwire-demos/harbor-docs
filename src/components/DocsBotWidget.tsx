import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./DocsBotWidget.css";

// SignalWire SDK is loaded via UMD script in Layout (/signalwire.js).
// Feature-sniff both Fabric and SignalWire constructor names because the SDK
// has exposed them under different globals across versions.
declare global {
  interface Window {
    SignalWire?: {
      SignalWire?: (opts: { token: string; logLevel?: string }) => Promise<SWClient>;
      Fabric?: (opts: { token: string; logLevel?: string }) => Promise<SWClient>;
    };
  }
}

interface SWClient {
  on: (event: string, handler: (params: unknown) => void) => void;
  disconnect: () => Promise<void> | void;
  dial: (opts: {
    to: string;
    rootElement: HTMLElement | null;
    audio?: boolean | MediaTrackConstraints;
    video?: boolean;
    negotiateVideo?: boolean;
    userVariables?: Record<string, unknown>;
  }) => Promise<RoomSession>;
}

interface RoomSession {
  on: (event: string, handler: (params: unknown) => void) => void;
  start: () => Promise<void>;
  hangup: () => Promise<void>;
  localStream?: MediaStream;
}

interface Props {
  agentUrl?: string;
}

type Status = "idle" | "connecting" | "connected" | "error";

interface DocsBotEvent {
  type?: string;
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// Event payload extraction — the SDK wraps user_event in several shapes
// depending on which of the three listener paths caught it. Normalize to a
// single shape with a `type` field.
// ────────────────────────────────────────────────────────────────────────────
function extractEvent(params: unknown): DocsBotEvent | null {
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  let data: Record<string, unknown> = p;
  if (p.params && typeof p.params === "object") data = p.params as Record<string, unknown>;
  if (p.event && typeof p.event === "object") data = p.event as Record<string, unknown>;
  if (typeof data.type !== "string") return null;
  return data as DocsBotEvent;
}

// ────────────────────────────────────────────────────────────────────────────
// Read the current Starlight page context from the URL + DOM.
// Starlight slugs are the path with leading/trailing slashes stripped, so
// /concepts/destinations/ → slug "concepts/destinations". Root is "".
// ────────────────────────────────────────────────────────────────────────────
// Module-level mirror of the current pinned-aside (split view) page.
// Updated by the pin_aside / close_aside event listeners inside
// DocsBotWidget; read by readPageState() so the widget's /page_state
// POST carries both primary and aside slugs. Keeps the agent's
// `current_page_block` in sync with what the reader actually sees.
let _asideState: { slug: string; title: string } | null = null;

function readPageState() {
  const path = window.location.pathname;
  const slug = path.replace(/^\/+/, "").replace(/\/+$/, "");
  const heading = (window.location.hash || "").replace(/^#/, "");
  return {
    current_page_path: path,
    current_page_slug: slug || "index",
    current_page_title: document.title.replace(/ \| Harbor$/, "").replace(/^Harbor$/, "Harbor"),
    current_heading_anchor: heading,
    current_aside_slug: _asideState?.slug ?? "",
    current_aside_title: _asideState?.title ?? "",
  };
}

// Scroll to a heading element and flash it briefly. Offsets the Starlight
// sticky header (~80px) so the heading doesn't land hidden under it.
function doScrollAndFlash(el: HTMLElement) {
  const header = document.querySelector("header.header") as HTMLElement | null;
  const offset = header?.offsetHeight ?? 80;
  const y = el.getBoundingClientRect().top + window.scrollY - offset - 8;
  window.scrollTo({ top: y, behavior: "smooth" });

  // Flash via a short-lived class so we don't fight Starlight's own styles.
  el.classList.add("docsbot-flash");
  window.setTimeout(() => el.classList.remove("docsbot-flash"), 1400);
}

export default function DocsBotWidget({ agentUrl: agentUrlProp }: Props) {
  // Runtime agent-URL resolution — build-time `PUBLIC_DOCSBOT_AGENT_URL` is
  // fast path; fall back to /api/docsbot-config.json (a runtime-rendered route
  // that reads the env var at request time). This pattern works even when the
  // static build doesn't inline PUBLIC_* correctly.
  const [resolvedAgentUrl, setResolvedAgentUrl] = useState<string>(
    (agentUrlProp || "").replace(/\/$/, ""),
  );

  useEffect(() => {
    if (resolvedAgentUrl) return;
    (async () => {
      try {
        const r = await fetch("/api/docsbot-config.json");
        if (!r.ok) return;
        const j = (await r.json()) as { agentUrl?: string };
        if (j.agentUrl) setResolvedAgentUrl(j.agentUrl.replace(/\/$/, ""));
      } catch {
        /* non-fatal; connect() will log a clearer error */
      }
    })();
  }, [resolvedAgentUrl]);

  const agentUrl = resolvedAgentUrl;

  // ─── UI state ────────────────────────────────────────────────────────────
  const [status, setStatus] = useState<Status>("idle");
  // Three-size state: "bubble" (minimized to the porthole), "shrunk" (compact
  // card that still shows Quincy + mic + compact chat input while keeping
  // the call active), "full" (large card with transcript area + controls).
  // Full↔Shrunk does NOT end the call. Bubble ends the call.
  type Size = "bubble" | "shrunk" | "full";
  const SIZE_PREF_KEY = "docsbot_preferred_size";
  const [size, setSize] = useState<Size>("bubble");
  // Remember which non-bubble size the reader prefers so click-to-restore
  // from the bubble returns them to that size on the next call.
  const preferredSizeRef = useRef<Exclude<Size, "bubble">>(
    (typeof window !== "undefined"
      ? (window.localStorage.getItem(SIZE_PREF_KEY) as
          | Exclude<Size, "bubble">
          | null)
      : null) ?? "full",
  );
  const [muted, setMuted] = useState(false);
  const [callStart, setCallStart] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string>("");

  // Attract-state: a larger bubble + speech-bubble callout on first visit
  // to make the voice demo obvious. Dismissed on first bubble click (and
  // persisted in localStorage so returning visitors don't get re-nagged).
  const ATTRACT_KEY = "docsbot_attract_dismissed";
  const [attractDismissed, setAttractDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true; // SSR: don't render attract
    try { return window.localStorage.getItem(ATTRACT_KEY) === "1"; }
    catch { return false; }
  });
  const dismissAttract = useCallback(() => {
    try { window.localStorage.setItem(ATTRACT_KEY, "1"); }
    catch { /* non-fatal */ }
    setAttractDismissed(true);
  }, []);

  // ─── SDK refs ────────────────────────────────────────────────────────────
  const clientRef = useRef<SWClient | null>(null);
  const roomRef = useRef<RoomSession | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const scopeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const callIdRef = useRef<string>("");
  // Widget token: shared secret issued by the agent in /get_token. Echoed back
  // as X-DocsBot-Token on /page_state + /chat so the agent can verify the call
  // originated from a real widget handshake rather than an arbitrary client.
  const widgetTokenRef = useRef<string>("");
  // Forward ref to pushPageState, populated after its declaration below.
  // Needed because the nav/scroll/aside event listener useEffect runs
  // BEFORE pushPageState is declared in the source order; refs let us
  // call it from there without a circular-closure hazard.
  const pushPageStateRef = useRef<() => Promise<void>>();

  // ─── call-duration ticker ────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "connected" || callStart === null) return;
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [status, callStart]);

  // ─── oscilloscope: real-time waveform from the user's mic ───────────────
  // Renders on canvas when the call is connected. Tied to localStream so it
  // naturally goes flat when muted (mic tracks disabled). Amber stroke on ink.
  useEffect(() => {
    if (status !== "connected") return;
    const canvas = scopeCanvasRef.current;
    const stream = roomRef.current?.localStream;
    if (!canvas || !stream) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Size the canvas to its CSS box × devicePixelRatio for crisp rendering.
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.scale(dpr, dpr);

    const AudioCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;

    const audioCtx = new AudioCtor();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    const bufferLength = analyser.fftSize;
    const data = new Uint8Array(bufferLength);

    let raf = 0;
    const w = rect.width;
    const h = rect.height;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(data);
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = "rgba(245, 181, 68, 0.92)"; // harbor-amber-400
      ctx.shadowColor = "rgba(232, 154, 31, 0.45)";
      ctx.shadowBlur = 6;
      ctx.beginPath();
      const slice = w / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = data[i] / 128.0; // 0..2, centered at 1
        const y = (v * h) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += slice;
      }
      ctx.stroke();
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      try { source.disconnect(); } catch { /* ignore */ }
      try { analyser.disconnect(); } catch { /* ignore */ }
      try { void audioCtx.close(); } catch { /* ignore */ }
    };
  }, [status]);

  const durationLabel = useMemo(() => {
    if (callStart === null) return "";
    const s = Math.floor((Date.now() - callStart) / 1000);
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = (s % 60).toString().padStart(2, "0");
    return `${m}:${ss}`;
  }, [callStart, status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Bridge SDK user_event → window CustomEvent ──────────────────────────
  // Cancelable so on-page components can claim an event with preventDefault
  // (e.g. a code block could claim its own highlight instead of letting the
  // floating widget flash it from the outside).
  const handleUserEvent = useCallback((params: unknown) => {
    const ev = extractEvent(params);
    if (!ev || !ev.type) return;
    window.dispatchEvent(new CustomEvent(ev.type, { detail: ev, cancelable: true }));
  }, []);

  // ─── Default page-action handlers ────────────────────────────────────────
  // The widget dispatches CustomEvents so on-page components can intercept
  // with preventDefault. These useEffects provide the default behavior when
  // nothing else claims the event.
  useEffect(() => {
    const onNavigate = async (e: Event) => {
      if (e.defaultPrevented) return;
      const detail = (e as CustomEvent).detail as {
        slug?: string;
        path?: string;
        heading_id?: string;
      };
      // Prefer an explicit path; fall back to "/<slug>/".
      const targetPath =
        detail?.path ||
        (detail?.slug != null ? `/${detail.slug}/`.replace(/\/\/+/g, "/") : null);
      if (!targetPath) return;
      const hash = detail?.heading_id ? `#${detail.heading_id}` : "";
      const fullTarget = targetPath + hash;

      // Use Astro's client-side router if available (SPA nav with view
      // transitions). Fall back to a full location change.
      try {
        const mod = await import("astro:transitions/client");
        if (typeof mod.navigate === "function") {
          mod.navigate(fullTarget);
          return;
        }
      } catch {
        /* astro:transitions not available — fall through */
      }
      window.location.href = fullTarget;
    };

    const onScrollTo = (e: Event) => {
      if (e.defaultPrevented) return;
      const detail = (e as CustomEvent).detail as { heading_id?: string };
      const id = detail?.heading_id;
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) {
        // Small delay + retry — page may still be rendering after a recent nav.
        setTimeout(() => {
          const retry = document.getElementById(id);
          if (retry) doScrollAndFlash(retry);
        }, 250);
        return;
      }
      doScrollAndFlash(el);
    };

    // Pin-to-side / close-aside state mirror — keeps _asideState in sync
    // with the agent's view of the split view, then triggers a page_state
    // push so the agent's current_page_block refreshes with both pages.
    const onPinAside = (e: Event) => {
      // Don't claim defaultPrevented — DocsBotAside is the primary renderer
      // and we want to run alongside it, not override it.
      const detail = (e as CustomEvent).detail as {
        slug?: string;
        title?: string;
      };
      if (!detail?.slug) return;
      _asideState = { slug: detail.slug, title: detail.title || detail.slug };
      // Fire-and-forget; the widget's own pushPageState effect will also
      // re-POST on the next nav / polling tick, so this is belt + suspenders.
      void pushPageStateRef.current?.();
    };
    const onCloseAside = () => {
      _asideState = null;
      void pushPageStateRef.current?.();
    };
    window.addEventListener("docsbot:pin_aside", onPinAside);
    window.addEventListener("docsbot:close_aside", onCloseAside);
    // When the reader dismisses the aside via the × button or Escape, the
    // aside component dispatches this event. Treat it the same as a
    // close_aside command from the agent so the state stays consistent.
    window.addEventListener("docsbot:aside_closed_by_user", onCloseAside);

    window.addEventListener("docsbot:navigate", onNavigate);
    window.addEventListener("docsbot:scroll_to", onScrollTo);
    return () => {
      window.removeEventListener("docsbot:navigate", onNavigate);
      window.removeEventListener("docsbot:scroll_to", onScrollTo);
      window.removeEventListener("docsbot:pin_aside", onPinAside);
      window.removeEventListener("docsbot:close_aside", onCloseAside);
      window.removeEventListener("docsbot:aside_closed_by_user", onCloseAside);
    };
  }, []);

  // ─── page → agent state channel ──────────────────────────────────────────
  const AGENT_HEADERS: Record<string, string> = {
    "ngrok-skip-browser-warning": "true",
  };

  const lastReportedPathRef = useRef<string>("");
  const lastReportedHashRef = useRef<string>("");

  const pushPageState = useCallback(async () => {
    if (!agentUrl || !callIdRef.current) return;
    const state = readPageState();
    lastReportedPathRef.current = state.current_page_path;
    lastReportedHashRef.current = state.current_heading_anchor;
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[docsbot] page_state push", state);
    }
    try {
      const headers: Record<string, string> = {
        ...AGENT_HEADERS,
        "Content-Type": "application/json",
      };
      if (widgetTokenRef.current) headers["X-DocsBot-Token"] = widgetTokenRef.current;
      await fetch(`${agentUrl}/page_state`, {
        method: "POST",
        headers,
        body: JSON.stringify({ call_id: callIdRef.current, state }),
      });
    } catch {
      /* non-fatal */
    }
  }, [agentUrl]);

  // Expose pushPageState to the pre-declared event listeners that need it.
  useEffect(() => {
    pushPageStateRef.current = pushPageState;
  }, [pushPageState]);

  // Astro view-transition + popstate + polling fallback.
  useEffect(() => {
    const onNav = () => void pushPageState();
    document.addEventListener("astro:page-load", onNav);
    document.addEventListener("astro:after-swap", onNav);
    window.addEventListener("popstate", onNav);
    window.addEventListener("hashchange", onNav);

    // 1.5s poll — catches manual history.pushState and SPA anchor clicks that
    // don't fire astro events (no-op when nothing has changed).
    const pollId = window.setInterval(() => {
      const curPath = window.location.pathname;
      const curHash = (window.location.hash || "").replace(/^#/, "");
      if (
        curPath !== lastReportedPathRef.current ||
        curHash !== lastReportedHashRef.current
      ) {
        void pushPageState();
      }
    }, 1500);

    return () => {
      document.removeEventListener("astro:page-load", onNav);
      document.removeEventListener("astro:after-swap", onNav);
      window.removeEventListener("popstate", onNav);
      window.removeEventListener("hashchange", onNav);
      window.clearInterval(pollId);
    };
  }, [pushPageState]);

  // ─── Connect / disconnect ────────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (!agentUrl) {
      setErrorMsg("Agent URL not configured. Set PUBLIC_DOCSBOT_AGENT_URL.");
      setStatus("error");
      return;
    }
    setStatus("connecting");
    setErrorMsg("");

    try {
      // 1) Fetch Fabric token + SIP address + widget_token from the agent.
      const tokenResp = await fetch(`${agentUrl}/get_token`, { headers: AGENT_HEADERS });
      if (!tokenResp.ok) throw new Error(`/get_token: ${tokenResp.status}`);
      const tokenData = (await tokenResp.json()) as {
        token?: string;
        address?: string;
        widget_token?: string;
        call_id?: string;
      };
      if (!tokenData.token || !tokenData.address) {
        throw new Error("agent returned no token/address");
      }
      widgetTokenRef.current = tokenData.widget_token ?? "";
      // Real call_id gets filled in by the SDK's `call.joined` event below.
      // Any value here is a placeholder that SignalWire won't recognize —
      // sending it to calling.ai_message returns 404. Do NOT use the
      // widget-UUID from /get_token as an actual call_id.
      callIdRef.current = "";

      // 2) Load SDK (it's already on window from <script src="/signalwire.js">).
      const SW = window.SignalWire;
      if (!SW) throw new Error("SignalWire SDK not loaded");
      const build = SW.SignalWire ?? SW.Fabric;
      if (!build) throw new Error("SignalWire SDK missing client constructor");
      const client = await build({ token: tokenData.token, logLevel: "warn" });
      clientRef.current = client;

      // 3) Bind user_event listeners (three shapes to tolerate SDK variance).
      client.on("user_event", handleUserEvent);
      client.on("calling.user_event", handleUserEvent);
      client.on("signalwire.event", (params: unknown) => {
        const p = params as { event_type?: string; params?: unknown };
        if (p?.event_type === "user_event") handleUserEvent(p.params ?? params);
      });

      // 4) Dial the Fabric address with initial page context as userVariables.
      const initial = readPageState();
      const room = await client.dial({
        to: tokenData.address,
        rootElement: videoContainerRef.current,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
        negotiateVideo: true,
        userVariables: {
          interface: "harbor-docs",
          ts: new Date().toISOString(),
          ...initial,
        },
      });
      roomRef.current = room;

      room.on("user_event", handleUserEvent);

      // call.joined fires once SignalWire establishes the call and hands
      // us the REAL call_id. Everything that targets calling.ai_message
      // (text chat, live page_state push) depends on this — without it,
      // every REST call to calling.ai_message 404s because the UUID the
      // widget made up isn't a real call in SW's tracking.
      room.on("call.joined", (params: unknown) => {
        const p = params as { call_id?: string };
        if (p?.call_id) callIdRef.current = p.call_id;
        setStatus("connected");
        setCallStart(Date.now());
        // Push initial page state now that we have a real call_id.
        void pushPageState();
      });

      const onEnded = () => handleDisconnect();
      room.on("room.left", onEnded);
      room.on("destroy", onEnded);
      room.on("call.ended", onEnded);
      room.on("session.ended", onEnded);

      await room.start();
      // setStatus("connected") and pushPageState happen inside call.joined
      // — not here — so the state reflects the real call_id, not a stub.
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[docsbot] connect failed:", err);
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
      setTimeout(() => setStatus("idle"), 2500);
    }
  }, [agentUrl, handleUserEvent, pushPageState]);

  // Pure local cleanup — no SDK hangup here. Called from the room-ended
  // event listeners (after the SDK has already ended the call) and from
  // hangup() below (after we've awaited the SDK's hangup promise).
  // Matches Prompt Pantry's split between handleDisconnect (cleanup) and
  // hangup (SDK shutdown).
  const handleDisconnect = useCallback(() => {
    setStatus("idle");
    setCallStart(null);
    setMuted(false);
    callIdRef.current = "";
    widgetTokenRef.current = "";

    if (videoContainerRef.current) {
      videoContainerRef.current.querySelectorAll("video").forEach((v) => {
        const s = v.srcObject as MediaStream | null;
        s?.getTracks().forEach((t) => t.stop());
        v.srcObject = null;
      });
      videoContainerRef.current.innerHTML = "";
    }

    roomRef.current = null;
    if (clientRef.current) {
      try { void clientRef.current.disconnect(); } catch { /* ignore */ }
      clientRef.current = null;
    }
  }, []);

  // End-call button path — MUST await the SDK's hangup before local cleanup,
  // or the SDK never finishes tearing down the WebRTC session and the end-
  // call button appears to do nothing. The fire-and-forget `roomRef.current
  // ?.hangup?.()` inside handleDisconnect was the bug.
  const hangup = useCallback(async () => {
    if (roomRef.current) {
      try {
        await roomRef.current.hangup();
      } catch {
        /* ignore — room may already be gone */
      }
    }
    handleDisconnect();
  }, [handleDisconnect]);

  // ─── Mute toggle ──────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const stream = roomRef.current?.localStream;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  }, [muted]);

  // ─── Chat (text channel) ──────────────────────────────────────────────────
  const sendChat = useCallback(async () => {
    const msg = chatInput.trim();
    if (!msg || !agentUrl || !callIdRef.current || chatSending) return;
    setChatSending(true);
    setChatInput("");
    try {
      const headers: Record<string, string> = {
        ...AGENT_HEADERS,
        "Content-Type": "application/json",
      };
      if (widgetTokenRef.current) headers["X-DocsBot-Token"] = widgetTokenRef.current;
      await fetch(`${agentUrl}/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ call_id: callIdRef.current, message: msg }),
      });
    } catch {
      /* non-fatal */
    } finally {
      setChatSending(false);
    }
  }, [agentUrl, chatInput, chatSending]);

  // ─── Render ───────────────────────────────────────────────────────────────

  // Helpers for the top-right controls (shared between shrunk and full).
  const remember = (nextSize: Exclude<Size, "bubble">) => {
    preferredSizeRef.current = nextSize;
    try { window.localStorage.setItem(SIZE_PREF_KEY, nextSize); }
    catch { /* non-fatal */ }
  };
  const goShrunk = () => { remember("shrunk"); setSize("shrunk"); };
  const goFull = () => { remember("full"); setSize("full"); };
  const goBubble = () => {
    // Minimize to bubble. If a call is live, END it — bubble is the
    // "not actively talking" state. Shrunk keeps the call alive for
    // "active but out of the way" use.
    if (status === "connected" || status === "connecting") void hangup();
    setSize("bubble");
  };

  if (size === "bubble") {
    const attract = !attractDismissed;
    return (
      <div className={`docsbot-root${attract ? " attract" : ""}`}>
        {attract && (
          <div className="docsbot-callout" role="status" aria-live="polite">
            <div className="docsbot-callout__eyebrow">Voice demo</div>
            <div className="docsbot-callout__headline">Ask Quincy anything about Harbor</div>
            <div className="docsbot-callout__hint">
              Try: <em>“How do I verify a webhook signature?”</em>
            </div>
            <span className="docsbot-callout__arrow" aria-hidden="true" />
          </div>
        )}
        <button
          className="docsbot-bubble"
          data-quincy="1"
          aria-label="Open Quincy — Harbor's docs assistant"
          onClick={() => {
            dismissAttract();
            // Restore to the reader's preferred non-bubble size (full on
            // first click of a fresh visit; whatever they last used after).
            setSize(preferredSizeRef.current);
          }}
        >
          {/* Fallback mic icon — hidden via CSS when data-quincy is set,
              but kept for a11y + older browsers without the portrait asset. */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </button>
      </div>
    );
  }

  const dotClass =
    status === "connected" ? "docsbot-dot connected" :
    status === "connecting" ? "docsbot-dot connecting" :
    status === "error" ? "docsbot-dot error" :
    "docsbot-dot";

  // Window controls (shrink + minimize) — shared across full / shrunk.
  // Shrink toggle switches between full and shrunk without ending the call.
  // Minimize ends the call and returns to the bubble state.
  const windowControls = (
    <div className="docsbot-wincontrols" aria-label="Widget controls">
      {size === "full" ? (
        <button
          className="docsbot-wincontrols__btn"
          aria-label="Shrink to compact"
          title="Shrink to compact"
          onClick={goShrunk}
        >
          {/* Down-caret-into-box glyph for shrink */}
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 14h8v6H8zM8 10l4-5 4 5" />
          </svg>
        </button>
      ) : (
        <button
          className="docsbot-wincontrols__btn"
          aria-label="Expand to full"
          title="Expand to full"
          onClick={goFull}
        >
          {/* Up-arrow-out-of-box glyph for expand */}
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 14H4v6h16v-6h-4M12 4v11M8 8l4-4 4 4" />
          </svg>
        </button>
      )}
      <button
        className="docsbot-wincontrols__btn docsbot-wincontrols__btn--close"
        aria-label="Minimize and end call"
        title="Minimize (ends the call)"
        onClick={goBubble}
      >
        ✕
      </button>
    </div>
  );

  if (size === "shrunk") {
    return (
      <div className="docsbot-root">
        <div
          className="docsbot-card docsbot-card--shrunk"
          role="dialog"
          aria-label="Harbor docs voice assistant (compact)"
        >
          <div className="docsbot-header docsbot-header--shrunk">
            <p className="docsbot-subtitle">
              Quincy
              {status === "connected" && (
                <span className="docsbot-duration-inline"> · {durationLabel}</span>
              )}
            </p>
            {windowControls}
          </div>

          <div className="docsbot-stage docsbot-stage--shrunk">
            {status === "idle" && (
              <video
                className="docsbot-quincy-vid"
                src="/quincy-idle.mp4"
                autoPlay loop muted playsInline
                poster="/quincy-portrait.jpg"
                aria-hidden="true"
              />
            )}
            <div className="docsbot-video" ref={videoContainerRef} />
            {status === "connecting" && (
              <div className="docsbot-video-placeholder connecting">Connecting…</div>
            )}
            {status === "error" && (
              <div className="docsbot-video-placeholder error">{errorMsg || "Connection error"}</div>
            )}
          </div>

          {status === "idle" && (
            <button className="primary docsbot-shrunk-cta" onClick={() => void connect()}>
              Start call
            </button>
          )}

          {status === "connected" && (
            <>
              <div className="docsbot-chat">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Type your question"
                  onKeyDown={(e) => { if (e.key === "Enter") void sendChat(); }}
                  disabled={chatSending}
                  aria-label="Chat message"
                />
                <button onClick={() => void sendChat()} disabled={!chatInput.trim() || chatSending}>
                  Send
                </button>
              </div>
              <div className="docsbot-controls docsbot-controls--shrunk">
                <button className={muted ? "muted" : ""} onClick={toggleMute}>
                  {muted ? "Unmute" : "Mute"}
                </button>
                <button className="danger" onClick={() => void hangup()}>End call</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="docsbot-root">
      <div className="docsbot-card" role="dialog" aria-label="Harbor docs voice assistant">
        <div className="docsbot-header">
          <div>
            <p className="docsbot-subtitle">Quincy · Staff engineer</p>
            <h3>Ask a question.</h3>
          </div>
          {windowControls}
        </div>

        {status === "connected" && (
          <div className="docsbot-scope" aria-hidden="true">
            <canvas ref={scopeCanvasRef} />
          </div>
        )}

        <div className="docsbot-stage">
          {/* Idle clip only — a loop of Quincy's portrait. Once the call
              starts, the Fabric platform composites quincy-talk.mp4 into the
              SDK video stream (see the agent's video_idle_file /
              video_talking_file SWML params), so we intentionally DON'T play
              a local talk clip here — two Quincys layered on top of each
              other is what we're avoiding. */}
          {status === "idle" && (
            <video
              className="docsbot-quincy-vid"
              src="/quincy-idle.mp4"
              autoPlay
              loop
              muted
              playsInline
              poster="/quincy-portrait.jpg"
              aria-hidden="true"
            />
          )}

          {/* SDK-managed container. SDK mounts its <video> element here
              once the call connects — that stream carries Fabric's composite
              of Quincy (idle/talking) and acts as the on-screen avatar. */}
          <div className="docsbot-video" ref={videoContainerRef} />

          {/* Overlay labels — above both videos. */}
          {status === "idle" && (
            <div className="docsbot-video-placeholder idle">Standing by</div>
          )}
          {status === "connecting" && (
            <div className="docsbot-video-placeholder connecting">Connecting…</div>
          )}
          {status === "error" && (
            <div className="docsbot-video-placeholder error">{errorMsg || "Connection error"}</div>
          )}
        </div>

        {status === "connected" && (
          <div className="docsbot-status">
            <span><span className={dotClass}></span>On call</span>
            <span className="docsbot-duration">{durationLabel}</span>
          </div>
        )}

        {status === "idle" && (
          <div className="docsbot-invite">
            <strong>Voice-first help</strong>
            Ask Quincy any question about Harbor — he'll answer out loud and take you to the right page.
          </div>
        )}

        {status === "connected" && (
          <div className="docsbot-chat">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="…or type your question"
              onKeyDown={(e) => { if (e.key === "Enter") void sendChat(); }}
              disabled={chatSending}
              aria-label="Chat message"
            />
            <button onClick={() => void sendChat()} disabled={!chatInput.trim() || chatSending}>
              Send
            </button>
          </div>
        )}

        <div className="docsbot-controls">
          {status === "idle" && (
            <button className="primary" onClick={() => void connect()}>Start call</button>
          )}
          {status === "connecting" && (
            <button disabled>Connecting…</button>
          )}
          {status === "connected" && (
            <>
              <button className={muted ? "muted" : ""} onClick={toggleMute}>
                {muted ? "Unmute" : "Mute"}
              </button>
              <button className="danger" onClick={() => void hangup()}>End call</button>
            </>
          )}
          {status === "error" && (
            <button onClick={() => void connect()}>Retry</button>
          )}
        </div>
      </div>
    </div>
  );
}

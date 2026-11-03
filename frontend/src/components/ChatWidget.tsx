"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { OptionCard } from "@/components/OptionCard";
import { describeFailure, sendChat } from "@/lib/api";
import { formatInr } from "@/lib/format";
import type { Booking, PlanOption } from "@/lib/types";

type Entry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; options: PlanOption[]; bookings: Booking[] }
  | { role: "error"; text: string };

const SUGGESTIONS = [
  "Delhi to Mumbai next Friday, 2 people, AC 3 tier",
  "Cheapest confirmed sleeper from Howrah to New Delhi in 3 weeks",
  "Show my bookings",
];

/** **bold**, line breaks and "- " / "* " bullets; everything else is plain text (no HTML). */
function Rich({ text }: { text: string }) {
  const inline = (line: string) =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>));
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`l${blocks.length}`}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) list.push(bullet[2]!);
    else {
      flush();
      if (line) blocks.push(<p key={`p${blocks.length}`}>{inline(line)}</p>);
    }
  }
  flush();
  return <>{blocks}</>;
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [entries, busy]);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setEntries((e) => [...e, { role: "user", text: message }]);
    setBusy(true);
    const outcome = await sendChat(message);
    setBusy(false);
    if (outcome.kind === "ok") {
      const { reply, options, bookings } = outcome.data;
      setEntries((e) => [...e, { role: "assistant", text: reply, options, bookings }]);
      if (bookings.length) window.dispatchEvent(new Event("reroute:bookings-changed"));
    } else {
      setEntries((e) => [
        ...e,
        { role: "error", text: outcome.kind === "unauthorized" ? "Please sign in to use the assistant." : describeFailure(outcome) },
      ]);
    }
  }

  async function reset() {
    setEntries([]);
    await sendChat("", true);
  }

  return (
    <>
      <button type="button" className="chat-launcher" aria-expanded={open} aria-controls="chat-panel" onClick={() => setOpen((o) => !o)}>
        {open ? "Close assistant" : "Ask the AI assistant"}
      </button>
      {open && (
        <section id="chat-panel" className="chat-panel" aria-label="AI ticket assistant">
          <header className="chat-head">
            <div>
              <strong>Reroute assistant</strong>
              <span>Finds and books confirmed seats</span>
            </div>
            <button type="button" className="secondary" onClick={() => void reset()} disabled={busy}>
              New chat
            </button>
          </header>
          <div className="chat-log" ref={log} aria-live="polite">
            {entries.length === 0 && (
              <div className="chat-empty">
                <p>Tell me where and when you want to travel. I&apos;ll search every route and berth combination and can book or cancel for you.</p>
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="chat-suggestion" onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            {entries.map((entry, i) =>
              entry.role === "user" ? (
                <div key={i} className="msg msg-user">
                  {entry.text}
                </div>
              ) : entry.role === "error" ? (
                <div key={i} className="msg msg-error" role="alert">
                  {entry.text}
                </div>
              ) : (
                <div key={i} className="msg msg-bot">
                  <Rich text={entry.text} />
                  {entry.options.slice(0, 3).map((o) => (
                    <OptionCard key={o.id} option={o} compact onBooked={() => window.dispatchEvent(new Event("reroute:bookings-changed"))} />
                  ))}
                  {entry.options.length > 3 && (
                    <p className="journey-meta">+{entry.options.length - 3} more: ask me, or use the Book tickets page.</p>
                  )}
                  {entry.bookings.map((b) => (
                    <p key={b.pnr} className="chat-booking">
                      PNR <strong>{b.pnr}</strong> · {b.source.code}→{b.destination.code} · {b.status.replace("_", " ").toLowerCase()} · {formatInr(b.totalFare)}
                    </p>
                  ))}
                </div>
              ),
            )}
            {busy && <div className="msg msg-bot typing">Checking trains and berths…</div>}
          </div>
          <form
            className="chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <label htmlFor="chat-text" className="visually-hidden">
              Message
            </label>
            <textarea
              id="chat-text"
              ref={field}
              rows={2}
              maxLength={1000}
              placeholder="e.g. Bengaluru to Hyderabad on Friday, sleeper"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            <button type="submit" disabled={busy || !input.trim()}>
              Send
            </button>
          </form>
        </section>
      )}
    </>
  );
}

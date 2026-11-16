/** The "about to respond" dots: a reply is on its way and nothing shows yet. */
export function PendingDots() {
  return (
    // Fades in rather than popping; the dots breathe on the token pulse
    // (``thinking-dot``), not Tailwind's bounce curve.
    <div className="oa-fade-in flex items-center gap-1.5 py-1" role="status" aria-label="Agent is preparing a response">
      <span aria-hidden="true" className="thinking-dot h-1.5 w-1.5 rounded-full bg-(--color-accent)" style={{ animationDelay: '0ms' }} />
      <span aria-hidden="true" className="thinking-dot h-1.5 w-1.5 rounded-full bg-(--color-accent)" style={{ animationDelay: '200ms' }} />
      <span aria-hidden="true" className="thinking-dot h-1.5 w-1.5 rounded-full bg-(--color-accent)" style={{ animationDelay: '400ms' }} />
    </div>
  )
}

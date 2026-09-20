"use client";

import { ReactNode, useLayoutEffect, useRef } from "react";

/** Measure before paint so both expansion and collapse start at the old height. */
export function SmoothResize({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const update = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const container = outer.current;
    const content = inner.current;
    if (!container || !content) return;
    let height = content.getBoundingClientRect().height;
    let animation: Animation | undefined;
    let frame = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const measure = () => {
      const next = content.getBoundingClientRect().height;
      if (Math.abs(next - height) < 1) return;
      const previous = animation || frame ? container.getBoundingClientRect().height : height;
      height = next;
      animation?.cancel();
      cancelAnimationFrame(frame);
      frame = 0;
      animation = undefined;
      if (reducedMotion.matches) { container.style.overflow = ""; container.style.height = ""; return; }
      container.style.overflow = "clip";
      container.style.height = `${previous}px`;
      // Start on a fresh frame: a large transcript can make the commit expensive.
      frame = requestAnimationFrame(() => {
        frame = 0;
        container.style.height = `${next}px`;
        animation = container.animate(
          [{ height: `${previous}px` }, { height: `${next}px` }],
          { duration: 260, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" },
        );
        // A long React commit can leave the document timeline on an old frame.
        animation.startTime = performance.now();
        animation.onfinish = () => {
          container.style.overflow = "";
          container.style.height = "";
          animation = undefined;
        };
      });
    };
    update.current = measure;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => { observer.disconnect(); animation?.cancel(); cancelAnimationFrame(frame); container.style.height = ""; container.style.overflow = ""; update.current = null; };
  }, []);
  useLayoutEffect(() => { update.current?.(); });
  return <div className="smooth-resize" ref={outer}><div className="smooth-resize-content" ref={inner}>{children}</div></div>;
}

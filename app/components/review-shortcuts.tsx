"use client";

import { useEffect } from "react";

type ReviewShortcutsProps = {
  enabled: boolean;
  canConfirm: boolean;
  canEdit: boolean;
  canReject: boolean;
  onConfirm: () => void;
  onEdit: () => void;
  onReject: () => void;
  onStep: (delta: 1 | -1) => void;
};

const KEY_HINTS = [
  { keys: "Enter", label: "确认" },
  { keys: "E", label: "修改" },
  { keys: "X", label: "不采纳" },
  { keys: "J / K", label: "上下切换" },
];

/**
 * Keyboard handling for the continuous review queue, rendered as a child so it
 * can hold its own effect without reordering ClaimScreen's early return.
 *
 * Reviewing a communication means deciding on every pending record in turn, and
 * each decision already advances to the next one. Reaching for the mouse for
 * each of them is the slow part, so the same three decisions are on the
 * keyboard, and the hints are shown rather than hidden.
 */
export function ReviewShortcuts({
  enabled,
  canConfirm,
  canEdit,
  canReject,
  onConfirm,
  onEdit,
  onReject,
  onStep,
}: ReviewShortcutsProps) {
  useEffect(() => {
    if (!enabled) return;
    function handle(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // Never steal a key from somewhere the reader is typing.
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const key = event.key.toLowerCase();
      if (key === "enter" && canConfirm) { event.preventDefault(); onConfirm(); return; }
      if (key === "e" && canEdit) { event.preventDefault(); onEdit(); return; }
      if (key === "x" && canReject) { event.preventDefault(); onReject(); return; }
      if (key === "j" || key === "arrowdown") { event.preventDefault(); onStep(1); return; }
      if (key === "k" || key === "arrowup") { event.preventDefault(); onStep(-1); }
    }
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [enabled, canConfirm, canEdit, canReject, onConfirm, onEdit, onReject, onStep]);

  if (!enabled) return null;
  return <p className="review-shortcut-hints" aria-label="键盘快捷键">
    {KEY_HINTS.map((hint) => <span key={hint.keys}><kbd>{hint.keys}</kbd>{hint.label}</span>)}
  </p>;
}

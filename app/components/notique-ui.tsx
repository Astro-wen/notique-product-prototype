"use client";

import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

type NqButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "quiet" | "accent" | "danger";
  loading?: boolean;
  size?: "compact" | "regular" | "large";
};

export function NqButton({ variant = "primary", size = "compact", loading = false, disabled, className = "", children, type = "button", ...props }: NqButtonProps) {
  return <button {...props} type={type} className={`button ${variant} nq-size-${size} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined}>
    <span className="nq-button-content">{loading && <i className="spinner" aria-hidden="true" />}{children}</span>
  </button>;
}

export function NqIconButton({ label, className = "", type = "button", ...props }: ComponentProps<"button"> & { label: string }) {
  return <button {...props} type={type} aria-label={label} className={`icon-button nq-icon-button ${className}`} />;
}

export function NqActionCard({ icon: Icon, kind = "audio", title, description, active = false, className = "", ...props }: Omit<ComponentProps<"button">, "title" | "children"> & {
  icon: LucideIcon; kind?: "record" | "audio" | "text" | "photo"; title: string; description: string; active?: boolean;
}) {
  return <button {...props} type="button" className={`landing-action${active ? " is-active" : ""} ${className}`} aria-pressed={kind === "record" ? active : undefined}>
    <span className={`landing-action-mark ${kind}`} aria-hidden="true"><Icon /></span><strong>{title}</strong><small>{description}</small>
  </button>;
}

export function NqSurface({ children, className = "", ...props }: ComponentProps<"section">) {
  return <section {...props} className={`nq-surface ${className}`}>{children}</section>;
}

export function NqStatus({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "success" | "pending" | "error" }) {
  return <span className={`nq-status ${tone}`}>{children}</span>;
}

export function NqProjectCard({ title, description, selected = false, onOpen, folder, records, modified, controls, className = "", ...props }: Omit<ComponentProps<"article">, "title" | "children" | "onClick"> & {
  title: string; description?: string; selected?: boolean; onOpen: () => void;
  folder: ReactNode; records: ReactNode; modified: ReactNode; controls: ReactNode;
}) {
  return <article {...props} className={`pi-item${selected ? " is-selected" : ""} ${className}`} onClick={event=>{
    if (!(event.target as HTMLElement).closest("button,input,[role='menuitem']")) onOpen();
  }}>
    <div className="pi-item-top">{controls}</div>
    <div className="pi-item-main"><button className="pi-title" title={description || `打开 ${title}`} onClick={onOpen}>{title}</button><div className="pi-associations">{folder}</div></div>
    <span className="pi-event-count">{records}</span><span className="pi-date">{modified}</span>
  </article>;
}

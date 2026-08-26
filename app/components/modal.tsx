import { ReactNode } from "react";
import { Dialog } from "radix-ui";

export function Modal({
  title,
  description,
  onClose,
  children,
  wide = false,
  dismissible = true,
  returnFocusSelector,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  dismissible?: boolean;
  returnFocusSelector?: string;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && dismissible) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className={`modal ${wide ? "modal-wide" : ""}`}
          onEscapeKeyDown={(event) => { if (!dismissible) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (!dismissible) event.preventDefault(); }}
          onInteractOutside={(event) => { if (!dismissible) event.preventDefault(); }}
          onCloseAutoFocus={(event) => {
            if (!returnFocusSelector) return;
            const target = document.querySelector<HTMLElement>(returnFocusSelector);
            if (!target) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <header className="modal-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description || "完成当前操作，或关闭此对话框返回上一页。"}</Dialog.Description>
            </div>
            <Dialog.Close asChild disabled={!dismissible}>
              <button className="icon-button" aria-label="关闭" disabled={!dismissible}>×</button>
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

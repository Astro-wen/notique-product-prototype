import { ReactNode } from "react";
import { X } from "lucide-react";
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
              {/* Radix 要求对话框挂一个 aria-describedby 目标，否则控制台会警告。
                  没有正文可说的对话框（标题本身够用，比如「新建项目」）不该为了
                  满足这个要求硬造一句空话给用户看，所以没有 description 时这句
                  只留给读屏，屏幕上不出现。 */}
              <Dialog.Description className={description ? undefined : "visually-hidden"}>
                {description || "完成当前操作，或关闭此对话框返回上一页。"}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild disabled={!dismissible}>
              <button className="icon-button" aria-label="关闭" disabled={!dismissible}><X aria-hidden="true" /></button>
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

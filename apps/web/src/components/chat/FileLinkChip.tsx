import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Eye, ExternalLink, Globe, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useUiStore } from "../../lib/uiStore";
import { toastManager as toast } from "../../lib/toast";

/** Delay before the hover menu closes, so moving the mouse from the chip to the menu doesn't
 *  close it in the gap between them. */
const HOVER_CLOSE_DELAY_MS = 200;

const MENU_ITEM_CLASS =
  "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground";

/**
 * Renders a `/shared-workspace/...` path mentioned in an agent message as an inline chip with a
 * hover menu (open in the internal browser, reveal in the file browser, open, delete) - instead
 * of leaving the user to copy the path and act on it by hand.
 *
 * This deliberately does NOT use the Radix DropdownMenu primitive: that component is built for
 * click/focus driven menus, and its internal pointer/focus-scope handling fought with a
 * hover-driven open state (menu opening and closing again on every hover tick). A portal'd plain
 * div positioned from the trigger's bounding rect, opened/closed by plain mouseenter/mouseleave
 * with a small close delay, is simpler and doesn't have that conflict.
 */
export function FileLinkChip({ rawText, relPath }: { rawText: string; relPath: string }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();
  const openBrowserUrl = useUiStore((s) => s.openBrowserUrl);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  };
  const openMenu = () => {
    cancelClose();
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setCoords({ top: rect.bottom + 4, left: rect.left });
    setOpen(true);
  };

  // Closing on scroll/resize avoids a menu left floating over the wrong spot once its anchor has
  // moved - this is a fixed-position portal, not a Radix popper, so it can't reposition itself.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => () => cancelClose(), []);

  const fileName = relPath.split("/").pop() || relPath;

  const handleOpenInternalBrowser = () => {
    setOpen(false);
    openBrowserUrl(api.shared.viewUrl(relPath));
  };

  const handleShowFile = () => {
    setOpen(false);
    navigate(`/shared?path=${encodeURIComponent(relPath)}`);
  };

  const handleOpen = () => {
    setOpen(false);
    window.open(api.shared.viewUrl(relPath), "_blank", "noopener,noreferrer");
  };

  const handleDelete = () => {
    setOpen(false);
    if (!window.confirm(`"${fileName}" wirklich löschen?`)) return;
    api.shared
      .deleteFile(relPath)
      .then(() => toast.success(`"${fileName}" gelöscht`))
      .catch((error) => toast.error(error instanceof Error ? error.message : "Löschen fehlgeschlagen"));
  };

  return (
    <>
      <code
        ref={triggerRef as React.RefObject<HTMLElement>}
        className="cursor-pointer rounded bg-black/40 px-1 py-0.5 font-mono text-[0.85em] text-amber-200 underline decoration-dotted decoration-amber-200/50 underline-offset-2 hover:bg-black/60"
        onMouseEnter={openMenu}
        onMouseLeave={scheduleClose}
      >
        {rawText}
      </code>
      {open && coords &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-50 min-w-[13rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            style={{ top: coords.top, left: coords.left }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            <button type="button" className={MENU_ITEM_CLASS} onClick={handleOpenInternalBrowser}>
              <Globe className="h-3.5 w-3.5" /> Im internen Browser öffnen
            </button>
            <button type="button" className={MENU_ITEM_CLASS} onClick={handleShowFile}>
              <Eye className="h-3.5 w-3.5" /> Datei anzeigen
            </button>
            <button type="button" className={MENU_ITEM_CLASS} onClick={handleOpen}>
              <ExternalLink className="h-3.5 w-3.5" /> Öffnen
            </button>
            <div className="-mx-1 my-1 h-px bg-border" />
            <button
              type="button"
              className={`${MENU_ITEM_CLASS} text-red-400 hover:bg-red-950/40 hover:text-red-300`}
              onClick={handleDelete}
            >
              <Trash2 className="h-3.5 w-3.5" /> Löschen
            </button>
          </div>,
          document.body
        )}
    </>
  );
}

import { useLocation, useNavigate } from "react-router-dom";
import { Menu, Plus } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { useAppStore } from "../../lib/store";
import { useUiStore } from "../../lib/uiStore";
import { DuckyMascot } from "../chat/DuckyMascot";
import type { NavGroup } from "./MoreNavSection";

/**
 * Phone-only header. The sidebar is off-canvas below `md`, so without this there is no
 * way to reach navigation - and no indication of which page you are on.
 */
export function MobileTopBar({
  navGroups,
  connected,
  busy,
}: {
  navGroups: NavGroup[];
  connected: boolean;
  busy: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const setMobileNavOpen = useUiStore((s) => s.setMobileNavOpen);
  const { setConversationId } = useAppStore();

  // Longest matching prefix wins, so /plugin/foo does not fall back to a shorter route.
  const current = navGroups
    .flatMap((group) => group.items)
    .filter((item) => location.pathname.startsWith(item.to))
    .sort((a, b) => b.to.length - a.to.length)[0];

  const startNewChat = () => {
    useAppStore.getState().clearChat();
    setConversationId(undefined);
    navigate("/chat");
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-2 md:hidden">
      <button
        type="button"
        onClick={() => setMobileNavOpen(true)}
        aria-label={t("layout.sidebar.openNav")}
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground active:bg-accent"
      >
        <Menu className="h-5 w-5" />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <DuckyMascot working={busy} connected={connected} size={22} />
        <span className="truncate text-sm font-semibold">{current?.label ?? "DucKI"}</span>
      </div>

      <button
        type="button"
        onClick={startNewChat}
        aria-label={t("layout.sidebar.newChat")}
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
      >
        <Plus className="h-5 w-5" />
      </button>
    </header>
  );
}

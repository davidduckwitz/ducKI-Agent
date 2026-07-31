import type { ComponentType } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { useUiStore } from "../../lib/uiStore";
import { useI18n } from "../../lib/i18n";
import { DividerToggle } from "../ui/collapsible-section";

export interface NavItem {
  to: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * Everything that is not "new chat" or a recent chat hides behind this divider.
 * While collapsed, the entry for the current route is still pinned above it - auto-
 * expanding instead would keep the whole navigation permanently open, since every
 * route lives in one of these groups.
 */
export function MoreNavSection({ groups }: { groups: NavGroup[] }) {
  const { t } = useI18n();
  const location = useLocation();
  const { moreOpen, setSection, navGroupOpen, toggleNavGroup } = useUiStore();

  const activeItem = groups
    .flatMap((group) => group.items)
    .find((item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`));
  const ActiveIcon = activeItem?.icon;

  return (
    <div className="shrink-0 pt-1">
      {!moreOpen && activeItem && ActiveIcon && (
        <NavLink to={activeItem.to} className="sidebar-item sidebar-item-active mx-1 mb-1">
          <ActiveIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{activeItem.label}</span>
        </NavLink>
      )}

      <DividerToggle label={t("layout.sidebar.more")} open={moreOpen} onToggle={() => setSection("more", !moreOpen)} />

      {moreOpen && (
        <div className="space-y-1 pb-2">
          {groups.map((group) => {
            const groupOpen = navGroupOpen[group.title] ?? true;
            return (
              <div key={group.title}>
                <button
                  type="button"
                  onClick={() => toggleNavGroup(group.title)}
                  aria-expanded={groupOpen}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 transition-colors hover:text-foreground"
                >
                  <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${groupOpen ? "" : "-rotate-90"}`} />
                  <span className="truncate">{group.title}</span>
                </button>

                {groupOpen && (
                  <div className="space-y-0.5 pl-1">
                    {group.items.map(({ to, icon: Icon, label }) => (
                      <NavLink
                        key={to}
                        to={to}
                        className={({ isActive }) => `sidebar-item ${isActive ? "sidebar-item-active" : ""}`}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{label}</span>
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Purely visual, per-browser UI state: which sidebar sections are folded away, which
 * chats the user pinned, how wide the coding agent panel is. None of this belongs on
 * the server - it is a workspace preference, not application data.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type CodingAgentTab = "chat" | "plan" | "activity";

/** Beyond these the panel would squeeze the editor into uselessness / vanish itself. */
export const CODING_AGENT_MIN_WIDTH = 280;
export const CODING_AGENT_MAX_WIDTH = 720;

interface UiState {
  /** Rail mode: sidebar shrinks to an icon strip. */
  sidebarCollapsed: boolean;
  /** Sidebar sections. "more" is closed by default - that is the whole point of it. */
  chatsOpen: boolean;
  filesOpen: boolean;
  moreOpen: boolean;
  navGroupOpen: Record<string, boolean>;
  /** Folder paths expanded in the coding file tree, keyed as `${project}:${path}`. */
  treeOpen: Record<string, boolean>;

  pinnedConversationIds: number[];

  /** Chat page's own conversation column - the sidebar covers the common case now. */
  chatListOpen: boolean;

  codingAgentOpen: boolean;
  codingAgentWidth: number;
  codingAgentTab: CodingAgentTab;
  codingSplitPreview: boolean;

  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setSection: (section: "chats" | "files" | "more", open: boolean) => void;
  toggleSection: (section: "chats" | "files" | "more") => void;
  setNavGroupOpen: (title: string, open: boolean) => void;
  toggleNavGroup: (title: string) => void;
  toggleTreeNode: (key: string) => void;
  setTreeNode: (key: string, open: boolean) => void;
  togglePin: (conversationId: number) => void;
  isPinned: (conversationId: number) => boolean;
  setChatListOpen: (open: boolean) => void;
  toggleChatList: () => void;
  setCodingAgentOpen: (open: boolean) => void;
  setCodingAgentWidth: (width: number) => void;
  setCodingAgentTab: (tab: CodingAgentTab) => void;
  setCodingSplitPreview: (enabled: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      chatsOpen: true,
      filesOpen: true,
      moreOpen: false,
      navGroupOpen: {},
      treeOpen: {},
      pinnedConversationIds: [],
      chatListOpen: false,
      codingAgentOpen: true,
      codingAgentWidth: 380,
      codingAgentTab: "chat",
      codingSplitPreview: false,

      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      setSection: (section, open) =>
        set(
          section === "chats"
            ? { chatsOpen: open }
            : section === "files"
              ? { filesOpen: open }
              : { moreOpen: open }
        ),
      toggleSection: (section) =>
        set((s) =>
          section === "chats"
            ? { chatsOpen: !s.chatsOpen }
            : section === "files"
              ? { filesOpen: !s.filesOpen }
              : { moreOpen: !s.moreOpen }
        ),

      setNavGroupOpen: (title, open) =>
        set((s) => (s.navGroupOpen[title] === open ? s : { navGroupOpen: { ...s.navGroupOpen, [title]: open } })),
      toggleNavGroup: (title) =>
        set((s) => ({ navGroupOpen: { ...s.navGroupOpen, [title]: !(s.navGroupOpen[title] ?? true) } })),

      toggleTreeNode: (key) => set((s) => ({ treeOpen: { ...s.treeOpen, [key]: !(s.treeOpen[key] ?? false) } })),
      setTreeNode: (key, open) =>
        set((s) => (s.treeOpen[key] === open ? s : { treeOpen: { ...s.treeOpen, [key]: open } })),

      togglePin: (conversationId) =>
        set((s) => ({
          pinnedConversationIds: s.pinnedConversationIds.includes(conversationId)
            ? s.pinnedConversationIds.filter((id) => id !== conversationId)
            : [conversationId, ...s.pinnedConversationIds],
        })),
      isPinned: (conversationId) => get().pinnedConversationIds.includes(conversationId),

      setChatListOpen: (chatListOpen) => set({ chatListOpen }),
      toggleChatList: () => set((s) => ({ chatListOpen: !s.chatListOpen })),

      setCodingAgentOpen: (codingAgentOpen) => set({ codingAgentOpen }),
      setCodingAgentWidth: (width) =>
        set({ codingAgentWidth: Math.min(Math.max(Math.round(width), CODING_AGENT_MIN_WIDTH), CODING_AGENT_MAX_WIDTH) }),
      setCodingAgentTab: (codingAgentTab) => set({ codingAgentTab }),
      setCodingSplitPreview: (codingSplitPreview) => set({ codingSplitPreview }),
    }),
    {
      name: "ducki.ui.v1",
      version: 1,
    }
  )
);

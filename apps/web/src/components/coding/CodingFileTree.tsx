import { useMemo } from "react";
import { ChevronRight, FileCode2, FileImage, FileJson, FileText, FileType, FolderClosed, FolderOpen } from "lucide-react";
import { useUiStore } from "../../lib/uiStore";

export interface CodingFileItem {
  path: string;
  type: "file" | "directory";
  size?: number;
  updatedAt?: string;
}

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children: TreeNode[];
}

/**
 * The API returns a flat path list; the UI needs a tree. Intermediate folders are
 * synthesised so `a/b/c.ts` renders correctly even when `a/b` is not listed itself.
 */
export function buildTree(files: CodingFileItem[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "directory", children: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (path: string): TreeNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = ensureDir(slash === -1 ? "" : path.slice(0, slash));
    const node: TreeNode = { name: path.slice(slash + 1), path, type: "directory", children: [] };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };

  for (const file of files) {
    const normalized = file.path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!normalized) continue;
    if (file.type === "directory") {
      ensureDir(normalized);
      continue;
    }
    const slash = normalized.lastIndexOf("/");
    const parent = ensureDir(slash === -1 ? "" : normalized.slice(0, slash));
    if (byPath.has(normalized)) continue;
    const node: TreeNode = { name: normalized.slice(slash + 1), path: normalized, type: "file", children: [] };
    parent.children.push(node);
    byPath.set(normalized, node);
  }

  const sortRecursive = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortRecursive);
  };
  sortRecursive(root);

  return root.children;
}

export function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "py", "css", "html", "htm", "sh"].includes(ext))
    return <FileCode2 className="h-3.5 w-3.5 shrink-0 text-primary" />;
  if (["json", "yml", "yaml", "xml"].includes(ext))
    return <FileJson className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext))
    return <FileImage className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
  if (["md", "markdown"].includes(ext))
    return <FileType className="h-3.5 w-3.5 shrink-0 text-sky-500" />;
  return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

export function CodingFileTree({
  files,
  project,
  selectedPath,
  dirtyPaths,
  filter,
  onSelect,
  onFolderAction,
  emptyLabel,
  noMatchLabel,
}: {
  files: CodingFileItem[];
  project: string;
  selectedPath: string;
  dirtyPaths: Set<string>;
  filter: string;
  onSelect: (path: string) => void;
  onFolderAction?: (folderPath: string) => void;
  emptyLabel: string;
  noMatchLabel: string;
}) {
  const { treeOpen, toggleTreeNode } = useUiStore();

  const needle = filter.trim().toLowerCase();
  const visibleFiles = useMemo(
    () => (needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files),
    [files, needle]
  );
  const tree = useMemo(() => buildTree(visibleFiles), [visibleFiles]);

  if (files.length === 0) return <p className="px-2 py-1 text-[11px] text-muted-foreground">{emptyLabel}</p>;
  if (visibleFiles.length === 0) return <p className="px-2 py-1 text-[11px] text-muted-foreground">{noMatchLabel}</p>;

  const renderNode = (node: TreeNode, depth: number) => {
    const key = `${project}:${node.path}`;
    // While filtering, keep everything open - otherwise matches hide inside closed folders.
    const open = needle ? true : (treeOpen[key] ?? depth === 0);
    const indent = { paddingLeft: `${depth * 10 + 4}px` };

    if (node.type === "directory") {
      return (
        <div key={node.path}>
          <div className="group flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => toggleTreeNode(key)}
              style={indent}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pr-1 text-left text-xs text-foreground/80 transition-colors hover:bg-accent"
            >
              <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
              {open ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              ) : (
                <FolderClosed className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              )}
              <span className="truncate">{node.name}</span>
            </button>
            {onFolderAction && (
              <button
                type="button"
                onClick={() => onFolderAction(node.path)}
                className="shrink-0 rounded px-1 text-sm leading-none text-muted-foreground opacity-0 transition hover:bg-background hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                title={`+ ${node.path}/`}
              >
                +
              </button>
            )}
          </div>
          {open && node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    const active = selectedPath === node.path;
    const dirty = dirtyPaths.has(node.path);
    return (
      <button
        key={node.path}
        type="button"
        onClick={() => onSelect(node.path)}
        style={indent}
        title={node.path}
        className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-1 text-left text-xs transition-colors ${
          active ? "bg-primary/15 font-medium text-foreground ring-1 ring-primary/40" : "hover:bg-accent"
        }`}
      >
        <span className="w-3 shrink-0" />
        <FileIcon name={node.name} />
        <span className="truncate">{node.name}</span>
        {dirty && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />}
      </button>
    );
  };

  return <div className="space-y-0.5">{tree.map((node) => renderNode(node, 0))}</div>;
}

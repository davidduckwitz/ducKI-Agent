export type ToolAliasEntry = {
    canonicalTool: string;
    aliases: string[];
    notes?: string;
};
export declare const TOOL_ALIAS_TABLE: ToolAliasEntry[];
export declare const TOOL_ALIAS_MAP: Map<string, string>;
export declare const TOOL_ACTION_ALIAS_MAP: Record<string, Record<string, string>>;
export declare function resolveToolAlias(toolName: string): string;
export declare function resolveToolAction(toolName: string, action: string): string | undefined;
//# sourceMappingURL=tool-aliases.d.ts.map
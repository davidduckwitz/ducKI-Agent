import { Bot } from "lucide-react";

export type AvatarInfo = { avatar?: string | null; name?: string };

function PetGlyph({ id, working }: { id: string; working?: boolean }) {
  if (id === "cat") return <span className={working ? "pet-emoji working" : "pet-emoji"}>🐱</span>;
  if (id === "ghost") return <span className={working ? "pet-emoji working" : "pet-emoji"}>👻</span>;
  if (id === "drone" || id === "coding-agent") return <span className={working ? "pet-emoji working" : "pet-emoji"}>🤖</span>;
  return <span className={working ? "pet-emoji working" : "pet-emoji"}>🦆</span>;
}

export function AgentAvatar({ avatar, name, working = false, size = 30 }: AvatarInfo & { working?: boolean; size?: number }) {
  const value = avatar?.trim() ?? "";
  if (/^(https?:\/\/|\/|data:image\/)/.test(value)) {
    const src = value.startsWith("/") ? `/erpel-api/agent-asset?path=${encodeURIComponent(value)}` : value;
    return <img className="agent-avatar-image" src={src} alt={name ?? "Agent"} style={{ width: size, height: size }} />;
  }
  if (["ducki", "duck-matrix", "cat", "ghost", "drone", "coding-agent"].includes(value)) {
    return <span className="agent-avatar-pet" style={{ width: size, height: size }}><PetGlyph id={value} working={working}/></span>;
  }
  return <span className="agent-avatar-fallback" style={{ width: size, height: size }}><Bot style={{ width: size * .58 }}/></span>;
}

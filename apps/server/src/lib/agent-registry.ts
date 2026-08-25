export type AgentRunSource = "chat_http" | "chat_ws" | "task_run" | "workflow_run" | "gateway_inbound";

export interface ActiveAgentEntry {
  id: string;
  source: AgentRunSource;
  startedAt: string;
  conversationId?: number;
  taskId?: number;
  socketId?: string;
  label?: string;
}

export class AgentRegistry {
  private active = new Map<string, ActiveAgentEntry>();
  private stopHandlers = new Map<string, () => void>();
  private listeners = new Set<(snapshot: { runningCount: number; agents: ActiveAgentEntry[] }) => void>();

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  subscribe(listener: (snapshot: { runningCount: number; agents: ActiveAgentEntry[] }) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  register(entry: Omit<ActiveAgentEntry, "id" | "startedAt">, controls?: { stop?: () => void }): string {
    const id = crypto.randomUUID();
    this.active.set(id, {
      id,
      startedAt: new Date().toISOString(),
      ...entry,
    });
    if (controls?.stop) this.stopHandlers.set(id, controls.stop);
    this.notify();
    return id;
  }

  update(id: string, patch: Partial<Omit<ActiveAgentEntry, "id" | "startedAt">>): void {
    const current = this.active.get(id);
    if (!current) return;
    this.active.set(id, {
      ...current,
      ...patch,
    });
    this.notify();
  }

  unregister(id: string): void {
    this.active.delete(id);
    this.stopHandlers.delete(id);
    this.notify();
  }

  stop(id: string): boolean {
    const stop = this.stopHandlers.get(id);
    if (!stop) return false;
    stop();
    return true;
  }

  snapshot(): { runningCount: number; agents: ActiveAgentEntry[] } {
    const agents = Array.from(this.active.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return {
      runningCount: agents.length,
      agents,
    };
  }
}

export const agentRegistry = new AgentRegistry();

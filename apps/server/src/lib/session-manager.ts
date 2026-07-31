/**
 * Hybrid Session Manager for MCP Tools
 * - Implicit: Sessions keyed by agentId (derived from request context)
 * - Explicit: Sessions with explicit sessionId passed in tool calls
 * - In-memory storage with optional persistence layer
 */

export interface SessionConfig {
  ttl?: number; // Session time-to-live in milliseconds (default: 1 hour)
  autoCleanup?: boolean; // Auto-cleanup expired sessions (default: true)
}

export interface SessionState {
  id: string;
  agentId?: string; // Optional agent context
  createdAt: number;
  lastAccessedAt: number;
  data: Record<string, unknown>;
  ttl: number;
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private config: Required<SessionConfig>;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: SessionConfig = {}) {
    this.config = {
      ttl: config.ttl ?? 60 * 60 * 1000, // 1 hour default
      autoCleanup: config.autoCleanup ?? true,
    };

    if (this.config.autoCleanup) {
      // Cleanup expired sessions every 5 minutes
      this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
      this.cleanupInterval.unref(); // Don't keep process alive for this timer
    }
  }

  /**
   * Create or get a session
   * @param sessionId - Explicit session ID (or auto-generate from agentId)
   * @param agentId - Agent context for implicit sessions
   */
  getOrCreateSession(sessionId?: string, agentId?: string): SessionState {
    const id = sessionId || agentId || this.generateSessionId();

    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        agentId,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        data: {},
        ttl: this.config.ttl,
      };
      this.sessions.set(id, session);
    } else {
      // Update last accessed time
      session.lastAccessedAt = Date.now();
    }

    return session;
  }

  /**
   * Get existing session without creating
   */
  getSession(sessionId: string): SessionState | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAccessedAt = Date.now();
    }
    return session;
  }

  /**
   * Store data in session
   */
  setSessionData<T>(sessionId: string, key: string, value: T): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.data[key] = value;
  }

  /**
   * Retrieve data from session
   */
  getSessionData<T>(sessionId: string, key: string): T | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return (session.data[key] as T) || undefined;
  }

  /**
   * Delete session
   */
  closeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * List all active sessions
   */
  listSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Cleanup expired sessions
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastAccessedAt > session.ttl) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Destroy manager and cleanup
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.sessions.clear();
  }
}

// Global singleton instance
let globalSessionManager: SessionManager | null = null;

export function getSessionManager(
  config?: SessionConfig
): SessionManager {
  if (!globalSessionManager) {
    globalSessionManager = new SessionManager(config);
  }
  return globalSessionManager;
}

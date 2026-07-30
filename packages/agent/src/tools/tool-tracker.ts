/**
 * Tool Call Tracking
 * Tracks tool calls and their results for display in UI
 */

import { EventEmitter } from "node:events";
import type { ToolResult } from "@ducki/shared";

export interface ToolCallRecord {
  id: string;
  toolName: string;
  action?: string;
  timestamp: string;
  input?: Record<string, unknown>;
  status: "executing" | "completed" | "failed";
  result?: {
    success: boolean;
    output?: string;
    error?: string;
    data?: unknown;
  };
  tabId?: string;
  duration?: number;
}

export class ToolCallTracker extends EventEmitter {
  private calls: Map<string, ToolCallRecord> = new Map();
  private callStack: string[] = [];

  startToolCall(
    toolName: string,
    input?: Record<string, unknown>,
    action?: string,
    tabId?: string
  ): string {
    const id = `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const call: ToolCallRecord = {
      id,
      toolName,
      action,
      timestamp: new Date().toISOString(),
      input,
      status: "executing",
      tabId,
    };

    this.calls.set(id, call);
    this.callStack.push(id);
    this.emit("call_started", call);

    return id;
  }

  completeToolCall(
    callId: string,
    result: ToolResult,
    duration?: number
  ): void {
    const call = this.calls.get(callId);
    if (!call) return;

    call.status = result.success ? "completed" : "failed";
    call.result = {
      success: result.success,
      output: result.data ? String(result.data) : undefined,
      error: result.error,
      data: result.data,
    };
    call.duration = duration;

    this.callStack = this.callStack.filter((id) => id !== callId);
    this.emit("call_completed", call);
  }

  failToolCall(
    callId: string,
    error: string,
    duration?: number
  ): void {
    const call = this.calls.get(callId);
    if (!call) return;

    call.status = "failed";
    call.result = {
      success: false,
      error,
    };
    call.duration = duration;

    this.callStack = this.callStack.filter((id) => id !== callId);
    this.emit("call_failed", call);
  }

  getCall(callId: string): ToolCallRecord | undefined {
    return this.calls.get(callId);
  }

  getAllCalls(): ToolCallRecord[] {
    return Array.from(this.calls.values());
  }

  getActiveCallsCount(): number {
    return this.callStack.length;
  }

  clear(): void {
    this.calls.clear();
    this.callStack = [];
  }
}

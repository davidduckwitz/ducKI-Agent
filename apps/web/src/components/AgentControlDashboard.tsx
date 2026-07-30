/**
 * Agent Control Dashboard
 * Real-time visualization & control of agent execution
 * Combines execution events, tool approval, metrics, and steering chat
 *
 * TODO: Re-enable when @ducki/agent types are available
 */

import React from "react";

export const AgentControlDashboard: React.FC<{
  onApproval?: (id: string, approved: boolean) => void;
  onSteeringMessage?: (message: string) => void;
  onStop?: () => void;
}> = () => {
  return <div>Agent Control Dashboard - Coming Soon</div>;
};

export default AgentControlDashboard;

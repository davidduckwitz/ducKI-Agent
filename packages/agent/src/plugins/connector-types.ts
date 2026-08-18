import type { PluginToolContext } from "./plugin-registry.js";

/**
 * Shared TS types for the connector-plugin capability (provides.connector - see
 * plugin-manifest.ts). A connector is a long-lived background integration (a messaging
 * platform bridge, e.g. Discord) shipped as a `trust: "node"` plugin, loaded and lifecycle-
 * managed by apps/server/src/lib/connector-registry.ts (NOT by plugin-registry.ts, which only
 * handles request-scoped tools).
 *
 * Design reference: docs/gateway-connector-plugin-plan.md section 4.
 */

/** Where an outbound message goes. `channelId` is the generic, portal-neutral address field -
 *  every connector must normalize its native addressing scheme onto this (see plan section 10.4:
 *  a Telegram connector maps its chatId -> channelId internally, the core never learns "chatId"). */
export interface ConnectorTarget {
  channelId: string;
  /** Optional thread/sub-conversation id within the channel, if the portal supports threads. */
  threadId?: string;
}

/** An attachment to send out. Exactly one of `path`/`url`/`data` should be set. */
export interface OutboundAttachment {
  name: string;
  /** Shared-workspace-relative path (preferred - resolved + size/type checked by the connector). */
  path?: string;
  url?: string;
  data?: Buffer;
  mimeType?: string;
}

export interface OutboundMessage {
  text: string;
  attachments?: OutboundAttachment[];
}

export interface InboundAttachment {
  id?: string;
  filename: string;
  url: string;
  mimeType?: string;
  size?: number;
}

/** A message arriving from a connector, normalized before it reaches the core inbound pipeline. */
export interface InboundMessage {
  portal: string;
  /** == ConnectorTarget.channelId for this portal - the conversation this message belongs to. */
  externalConversationId: string;
  sourceMessageId?: string;
  channelName?: string;
  authorId?: string;
  userName?: string;
  content: string;
  attachments?: InboundAttachment[];
}

/** Runtime connection status, surfaced via app.locals["connectorStatuses"][portal]. */
export interface ConnectorStatus {
  configured: boolean;
  active: boolean;
  connectedAt?: string;
  lastError?: string;
  updatedAt: string;
}

/**
 * Capability metadata a connector declares so the agent gets ground truth in the `gateway`
 * tool's `list_configs` result instead of relying on prose memory (plan section 10.3).
 */
export interface ConnectorCapabilities {
  maxMessageLength: number;
  supportsAttachments: boolean;
  supportsReactions: boolean;
  /** The field name the core alias-normalizer resolves to (must be "channelId" - see plan 10.4). */
  targetFieldName: string;
  exampleTarget: string;
}

/** Minimal request shape a webhook handler receives (Express-agnostic so the plugin has no
 *  dependency on express types). */
export interface ConnectorWebhookRequest {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string;
  params: Record<string, string>;
}

export interface ConnectorWebhookResponse {
  status: number;
  body?: unknown;
}

/** Context handed to a connector on connect() - reuses the plugin tool context (settings,
 *  secrets, guarded fetch, logger) plus the inbound dispatch hook into the agent run pipeline. */
export interface ConnectorContext extends PluginToolContext {
  /** Stable portal id from the manifest (provides.connector.portal). */
  portal: string;
  /**
   * Direct in-process dispatch into the core inbound pipeline (equivalent to what used to be an
   * HTTP self-POST to /api/gateway/inbound). Chosen over the loopback HTTP call because a
   * trust:"node" plugin already runs in the same process - see connector-registry.ts for the
   * rationale and docs/gateway-connector-plugin-plan.md section 11 risk #1.
   */
  onInboundMessage(msg: InboundMessage): Promise<void>;
}

/** The interface every connector plugin's `connector.js` module must implement, via a
 *  `createConnector(manifest)` factory export. TS analogue of hermes-agent's BasePlatformAdapter. */
export interface ConnectorAdapter {
  connect(ctx: ConnectorContext): Promise<void>;
  disconnect(): Promise<void>;
  send(target: ConnectorTarget, message: OutboundMessage): Promise<void>;
  /** Optional: react to an inbound message (emoji ack). Not every portal supports this. */
  reactToMessage?(target: ConnectorTarget, messageId: string, emoji: string): Promise<void>;
  /** Optional: handle an inbound webhook call for this portal (signature verification,
   *  interaction responses, ...). Returning undefined means "not handled, fall through". */
  handleWebhook?(req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse | undefined>;
  getStatus(): ConnectorStatus;
  getCapabilities?(): ConnectorCapabilities;
}

/** Shape a connector module must export. */
export interface ConnectorModuleExports {
  createConnector: (manifest: { portal: string; pluginName: string }) => ConnectorAdapter;
}

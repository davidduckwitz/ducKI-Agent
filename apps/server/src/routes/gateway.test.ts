import { isGatewayConversationName } from "./gateway";

const discordConfig = {
  id: "discord_main",
  portal: "discord" as const,
  name: "Discord Main",
  enabled: true,
};

describe("isGatewayConversationName", () => {
  test("matches the name the inbound path actually creates", () => {
    expect(isGatewayConversationName("[discord] Discord Main · 12345", [discordConfig])).toBe(true);
  });

  test("matches a forced new-session conversation", () => {
    const name = "[discord] Discord Main · 12345 · session 2026-07-26T15:00:00.000Z";
    expect(isGatewayConversationName(name, [discordConfig])).toBe(true);
  });

  test("matches a conversation whose config was renamed or removed", () => {
    // The old listing filter also required a "·"; a name tagged with the portal but
    // written by an earlier naming scheme stayed invisible in the Gateway UI forever.
    expect(isGatewayConversationName("[discord] alter Name ohne Trenner", [])).toBe(true);
  });

  test("matches the runtime fallback config used before a gateway is saved", () => {
    expect(isGatewayConversationName("[telegram] telegram gateway · 42", [])).toBe(true);
  });

  test("ignores ordinary chats", () => {
    expect(isGatewayConversationName("Conversation 26.07.2026, 15:00:00", [discordConfig])).toBe(false);
    expect(isGatewayConversationName("[Coding] mein-projekt", [discordConfig])).toBe(false);
  });

  test("does not match a bracketed name that is not a portal", () => {
    expect(isGatewayConversationName("[Notiz] Discord Main · 1", [])).toBe(false);
  });
});

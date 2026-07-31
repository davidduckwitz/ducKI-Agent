
/**
 * Landing Page Configuration
 * The agent can reference this URL to understand its own capabilities
 */
export const LANDING_PAGE_CONFIG = {
  url: 'https://ducki-ai-agent.davidduckwitz.de/',
  api: 'https://ducki-ai-agent.davidduckwitz.de/landing/api/v1.php',
  endpoints: {
    tools: '?action=tools',
    skills: '?action=skills',
    skill: '?action=skill&id={id}',
    tool: '?action=tool&id={id}',
    categories: '?action=categories',
    audit: '?action=audit'
  },
  description: 'Public agent inventory and documentation'
};

/**
 * Browser Automation Helpers für Agent
 * - Cookie-Banner dismissal
 * - Captcha detection & handling
 * - JavaScript-heavy page interaction
 * - Cookie acceptance automation
 */

export interface BrowserAutomationConfig {
  dismissCookies: boolean;
  handleCaptchas: boolean;
  autoScroll: boolean;
  loadAllContent: boolean;
}

export const DEFAULT_BROWSER_AUTOMATION: BrowserAutomationConfig = {
  dismissCookies: true,
  handleCaptchas: true,
  autoScroll: true,
  loadAllContent: true,
};

/**
 * JavaScript Code zum Ausführen im Browser für Cookie-Dismissal
 */
export const COOKIE_DISMISSAL_SCRIPT = `
(function dismissCookies() {
  const results = [];

  // Common cookie banner patterns
  const selectors = [
    // Cookie consent buttons
    '[id*="cookie"][class*="accept"]',
    '[id*="cookie"][class*="agree"]',
    '[class*="cookie"][class*="accept"]',
    '[data-test-id*="cookie"]',
    'button:contains("Accept")',
    'button:contains("Agree")',
    'button:contains("Accept all")',
    'button:contains("Allow all")',
    '.cookie-banner button[type="button"]:first-of-type',
    '.cookie-consent button.accept',
    '.cookie-notice button.accept',
    '[class*="gdpr"] button:first-of-type',
    'iframe[title*="cookie"]',
    'iframe[src*="cookie"]',
  ];

  // Try to click accept buttons
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      if (el && el.offsetHeight > 0) {
        try {
          (el as any).click?.();
          results.push('Clicked: ' + selector);
          break;
        } catch (e) {
          // Continue
        }
      }
    }
  }

  // Try to close cookie modals by finding X buttons
  const closeButtons = document.querySelectorAll(
    'button[aria-label*="Close"], button[aria-label*="close"], .close, [class*="close"] button'
  );

  for (const btn of closeButtons) {
    const parent = (btn as any).closest('[class*="cookie"], [class*="modal"], [id*="cookie"]');
    if (parent) {
      try {
        (btn as any).click?.();
        results.push('Closed modal');
      } catch (e) {
        // Continue
      }
    }
  }

  // Hide cookie banners by CSS
  const cookieBanners = document.querySelectorAll(
    '[id*="cookie"], [class*="cookie-banner"], [class*="cookie-consent"], [class*="gdpr"]'
  );

  for (const banner of cookieBanners) {
    (banner as any).style.display = 'none';
    results.push('Hidden banner');
  }

  return {
    success: results.length > 0,
    actions: results,
    message: \`Attempted to dismiss cookies and banners: \${results.join(', ')}\`
  };
})();
`;

/**
 * Script zum Detect von CAPTCHAs
 */
export const CAPTCHA_DETECTION_SCRIPT = `
(function detectCaptchas() {
  const captchas = [];

  // reCAPTCHA v2 & v3
  if (window.grecaptcha) {
    captchas.push({
      type: 'reCAPTCHA',
      version: window.grecaptcha.getResponse ? 'v2' : 'v3',
      detected: true,
    });
  }

  // hCaptcha
  if (window.hcaptcha) {
    captchas.push({
      type: 'hCaptcha',
      detected: true,
    });
  }

  // Cloudflare Challenge
  if (document.querySelector('[data-cf-challenge]')) {
    captchas.push({
      type: 'Cloudflare',
      detected: true,
    });
  }

  // Generic CAPTCHA form patterns
  if (document.querySelector('input[name*="captcha"]')) {
    captchas.push({
      type: 'Generic Form',
      detected: true,
    });
  }

  return {
    captchasFound: captchas.length > 0,
    captchas: captchas,
    message: captchas.length > 0
      ? \`Found \${captchas.length} CAPTCHA(s): \${captchas.map(c => c.type).join(', ')}\`
      : 'No CAPTCHAs detected'
  };
})();
`;

/**
 * Script zum Auto-Scroll für lazy-loaded content
 */
export const AUTO_SCROLL_SCRIPT = `
(async function autoScroll() {
  const initialHeight = document.body.scrollHeight;
  let scrolled = 0;
  const maxIterations = 20;
  let iterations = 0;

  while (iterations < maxIterations) {
    window.scrollBy(0, window.innerHeight);
    scrolled += window.innerHeight;

    // Wait für lazy loading
    await new Promise(resolve => setTimeout(resolve, 1000));

    const newHeight = document.body.scrollHeight;
    if (newHeight === initialHeight) break;

    iterations++;
  }

  return {
    success: true,
    scrolledDistance: scrolled,
    iterations: iterations,
    message: \`Scrolled \${scrolled}px in \${iterations} iterations\`
  };
})();
`;

/**
 * Script zum Entfernen von Overlays und Popups
 */
export const REMOVE_OVERLAYS_SCRIPT = `
(function removeOverlays() {
  const removed = [];

  // Remove modal overlays
  const overlaySelectors = [
    '.overlay',
    '[class*="overlay"]',
    '[class*="modal"]',
    '[class*="popup"]',
    '[class*="dialog"]',
    '[role="dialog"]',
    '[role="alertdialog"]',
  ];

  for (const selector of overlaySelectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      // Only remove if it's blocking content
      if ((el as any).offsetWidth > window.innerWidth * 0.3) {
        (el as any).style.display = 'none';
        removed.push(selector);
      }
    }
  }

  // Remove body scroll lock
  document.body.style.overflow = 'auto';
  document.documentElement.style.overflow = 'auto';

  return {
    success: removed.length > 0,
    removed: Array.from(new Set(removed)),
    message: \`Removed \${removed.length} overlay(s)\`
  };
})();
`;

/**
 * Helper zum Generieren des kompletten Browser Automation Script
 */
export function generateBrowserAutomationScript(config: BrowserAutomationConfig): string {
  const scripts: string[] = [];

  if (config.dismissCookies) {
    scripts.push(`const cookieResult = ${COOKIE_DISMISSAL_SCRIPT}`);
  }

  if (config.handleCaptchas) {
    scripts.push(`const captchaResult = ${CAPTCHA_DETECTION_SCRIPT}`);
  }

  if (config.autoScroll) {
    scripts.push(`const scrollResult = ${AUTO_SCROLL_SCRIPT}`);
  }

  scripts.push(`const overlayResult = ${REMOVE_OVERLAYS_SCRIPT}`);

  scripts.push(`
    return {
      cookies: ${config.dismissCookies ? 'cookieResult' : 'null'},
      captchas: ${config.handleCaptchas ? 'captchaResult' : 'null'},
      scrolled: ${config.autoScroll ? 'scrollResult' : 'null'},
      overlays: overlayResult,
      timestamp: new Date().toISOString()
    };
  `);

  return `(async function() { ${scripts.join('\n')} })()`;
}

/**
 * Browser Session Manager für persistent Sessions
 */
export class BrowserSessionManager {
  private sessions: Map<string, { url: string; cookies: string[]; isActive: boolean }> = new Map();

  registerSession(tabId: string, url: string): void {
    this.sessions.set(tabId, {
      url,
      cookies: [],
      isActive: true,
    });
  }

  updateSession(tabId: string, url: string): void {
    const session = this.sessions.get(tabId);
    if (session) {
      session.url = url;
      session.isActive = true;
    }
  }

  getSession(tabId: string): { url: string; cookies: string[]; isActive: boolean } | undefined {
    return this.sessions.get(tabId);
  }

  closeSession(tabId: string): void {
    this.sessions.delete(tabId);
  }

  listSessions(): Array<{ tabId: string; url: string; isActive: boolean }> {
    return Array.from(this.sessions.entries()).map(([tabId, session]) => ({
      tabId,
      ...session,
    }));
  }
}

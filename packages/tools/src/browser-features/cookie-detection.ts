import type { Page } from "puppeteer-core";

export interface CookieBannerDetectionResult {
  found: boolean;
  dismissed: boolean;
  selectors: string[];
  error?: string;
}

/**
 * Common selectors for cookie banners and consent managers
 */
const COOKIE_BANNER_SELECTORS = [
  // Text-based selectors
  'button:has-text("Accept All")',
  'button:has-text("Accept all")',
  'button:has-text("Agree to all")',
  'button:has-text("Reject All")',
  'button:has-text("Dismiss")',

  // Common data attributes
  '[data-testid*="cookie"]',
  '[data-testid*="consent"]',
  '[id*="cookie"]',
  '[id*="consent"]',
  '[class*="cookie-banner"]',
  '[class*="consent-banner"]',

  // Role-based selectors
  '[role="dialog"][aria-label*="cookie"]',
  '[role="dialog"][aria-label*="Cookie"]',

  // Common IDs and classes
  '#cookie-banner',
  '#cookiebanner',
  '.cookie-banner',
  '.cookie-consent',
  '.consent-banner',
  '.gdpr-banner',
  '#didomi-notice', // Didomi consent manager
  '.consentmanager', // Consentmanager
  '#__didomi', // Didomi alternative
];

/**
 * Attempt to detect and dismiss common cookie banners
 */
export async function detectAndDismissCookieBanners(page: Page): Promise<CookieBannerDetectionResult> {
  try {
    const result: CookieBannerDetectionResult = {
      found: false,
      dismissed: false,
      selectors: [],
    };

    // Try each selector
    for (const selector of COOKIE_BANNER_SELECTORS) {
      try {
        // Handle :has-text selector (not standard in puppeteer)
        let actualSelector = selector;
        if (selector.includes(":has-text")) {
          // Convert :has-text to XPath for better compatibility
          const text = selector.match(/:has-text\("([^"]+)"\)/)?.[1];
          if (text) {
            actualSelector = `//*[contains(text(), "${text}")]`;
          }
        }

        const element = await page.$(actualSelector);
        if (element) {
          result.found = true;
          result.selectors.push(selector);

          try {
            // Try to click the button
            await element.click();
            // Wait for possible animations
            await new Promise((resolve) => setTimeout(resolve, 500));
            result.dismissed = true;
            console.log(`[cookie-detection] Dismissed cookie banner using selector: ${selector}`);
            break; // Stop after first successful dismissal
          } catch (clickError) {
            console.warn(`[cookie-detection] Found cookie banner but failed to click: ${clickError}`);
          }
        }
      } catch (selectorError) {
        // Selector didn't match, continue to next
      }
    }

    return result;
  } catch (error) {
    return {
      found: false,
      dismissed: false,
      selectors: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Set up resource blocking on the page
 * Blocks ads, tracking, or all external resources based on setting
 */
export async function setupResourceBlocking(
  page: Page,
  blockMode: "none" | "tracking" | "ads" | "all"
): Promise<void> {
  if (blockMode === "none") return;

  // List of resource types to block
  const trackingDomains = [
    "google-analytics",
    "analytics",
    "doubleclick",
    "googleadservices",
    "facebook",
    "instagram",
    "twitter",
    "segment",
    "mixpanel",
    "amplitude",
    "hotjar",
  ];

  const adNetworks = [
    "googleads",
    "adservices",
    "adnxs",
    "criteo",
    "outbrain",
    "taboola",
  ];

  await page.on("request", (request) => {
    const url = request.url().toLowerCase();
    let shouldBlock = false;

    if (blockMode === "all") {
      // Block all external resources except document/script/stylesheet/xhr
      const type = request.resourceType();
      if (!["document", "script", "stylesheet", "xhr", "fetch"].includes(type)) {
        shouldBlock = true;
      }
    } else if (blockMode === "tracking") {
      // Block tracking only
      shouldBlock = trackingDomains.some((domain) => url.includes(domain));
    } else if (blockMode === "ads") {
      // Block ads and tracking
      shouldBlock =
        trackingDomains.some((domain) => url.includes(domain)) ||
        adNetworks.some((domain) => url.includes(domain));
    }

    if (shouldBlock) {
      request.abort();
    } else {
      request.continue();
    }
  });
}

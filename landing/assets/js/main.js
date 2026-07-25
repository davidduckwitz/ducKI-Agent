/**
 * DucKI Agent Landing Page - Main JavaScript
 */

// Dark mode toggle (if needed)
document.addEventListener('DOMContentLoaded', function() {
    initializeDarkMode();
    initializeNavigation();
});

/**
 * Initialize dark mode preferences
 */
function initializeDarkMode() {
    // Check for saved preference or system preference
    const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const html = document.documentElement;

    // Listen for system theme changes
    darkModeQuery.addEventListener('change', (e) => {
        if (e.matches) {
            html.classList.add('dark');
        } else {
            html.classList.remove('dark');
        }
    });

    // Apply system preference on page load
    if (darkModeQuery.matches) {
        html.classList.add('dark');
    }
}

/**
 * Initialize navigation
 */
function initializeNavigation() {
    // Close mobile menu when clicking outside
    const navItems = document.querySelectorAll('nav a');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            // Any additional navigation handling
        });
    });

    // Highlight current page in navigation
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    navItems.forEach(item => {
        const href = item.getAttribute('href');
        if (href && (href === currentPage || (currentPage === '' && href === '/'))) {
            item.classList.add('text-blue-600', 'dark:text-blue-400');
        }
    });
}

/**
 * Smooth scroll to section
 */
function scrollToSection(sectionId) {
    const element = document.getElementById(sectionId);
    if (element) {
        element.scrollIntoView({ behavior: 'smooth' });
    }
}

/**
 * Format date for display
 */
function formatDate(date) {
    if (typeof date === 'string') {
        date = new Date(date);
    }
    return date.toLocaleDateString('de-DE', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

/**
 * Copy text to clipboard
 */
function copyToClipboard(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            console.log('Copied to clipboard:', text);
        }).catch(err => {
            console.error('Failed to copy:', err);
        });
    } else {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
    }
}

/**
 * Fetch and cache data
 */
class DataCache {
    constructor(key, ttl = 3600000) {
        this.key = key;
        this.ttl = ttl;
    }

    get() {
        const data = localStorage.getItem(this.key);
        if (!data) return null;

        const cached = JSON.parse(data);
        if (Date.now() - cached.timestamp > this.ttl) {
            localStorage.removeItem(this.key);
            return null;
        }

        return cached.data;
    }

    set(data) {
        localStorage.setItem(this.key, JSON.stringify({
            data: data,
            timestamp: Date.now()
        }));
    }

    clear() {
        localStorage.removeItem(this.key);
    }
}

/**
 * API Helper
 */
class APIClient {
    constructor(baseURL = 'api') {
        this.baseURL = baseURL;
        this.cache = {};
    }

    async request(endpoint, options = {}) {
        const url = `${this.baseURL}/index.php${endpoint}`;
        const cacheKey = `${endpoint}_${JSON.stringify(options)}`;

        // Check cache
        if (options.useCache && this.cache[cacheKey]) {
            return this.cache[cacheKey];
        }

        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                throw new Error(`API Error: ${response.status} ${response.statusText}`);
            }
            const data = await response.json();

            // Cache the response
            if (options.useCache) {
                this.cache[cacheKey] = data;
            }

            return data;
        } catch (error) {
            console.error('API request failed:', error);
            throw error;
        }
    }

    async getTools(options = {}) {
        options.useCache = true;
        const params = new URLSearchParams(options).toString();
        const endpoint = `/tools${params ? '?' + params : ''}`;
        return this.request(endpoint);
    }

    async getSkills(options = {}) {
        options.useCache = true;
        const params = new URLSearchParams(options).toString();
        const endpoint = `/skills${params ? '?' + params : ''}`;
        return this.request(endpoint);
    }

    async getTool(id) {
        return this.request(`/tools/${id}`, { useCache: true });
    }

    async getSkill(id) {
        return this.request(`/skills/${id}`, { useCache: true });
    }

    async getHealth() {
        return this.request('/health');
    }

    clearCache() {
        this.cache = {};
    }
}

// Create global API client instance
window.api = new APIClient();

/**
 * Utility: Debounce function
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Utility: Throttle function
 */
function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * Utility: Check if element is in viewport
 */
function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
}

/**
 * Lazy load images
 */
function initLazyLoad() {
    const images = document.querySelectorAll('img[data-src]');
    if ('IntersectionObserver' in window) {
        const imageObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    img.src = img.dataset.src;
                    img.removeAttribute('data-src');
                    observer.unobserve(img);
                }
            });
        });

        images.forEach(img => imageObserver.observe(img));
    } else {
        // Fallback for browsers without IntersectionObserver
        images.forEach(img => {
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
        });
    }
}

/**
 * Track analytics (if needed)
 */
function trackEvent(eventName, eventData = {}) {
    if (window.gtag) {
        gtag('event', eventName, eventData);
    }
    console.log('Event tracked:', eventName, eventData);
}

/**
 * Export utilities for use in other modules
 */
window.DucKI = {
    copyToClipboard,
    scrollToSection,
    formatDate,
    DataCache,
    APIClient,
    debounce,
    throttle,
    isInViewport,
    initLazyLoad,
    trackEvent
};

// ============================================
// Client-Side Cache System for 3x Faster Loads
// ============================================
const ClientCache = {
    TTL: {
        sections: 5 * 60 * 1000,      // 5 minutes
        grades: 2 * 60 * 1000,        // 2 minutes
        assignments: 3 * 60 * 1000,   // 3 minutes
        courses: 5 * 60 * 1000        // 5 minutes
    },
    
    get(key, ttl = 5 * 60 * 1000) {
        try {
            const item = localStorage.getItem('cache_' + key);
            if (!item) return null;
            
            const { data, timestamp } = JSON.parse(item);
            const age = Date.now() - timestamp;
            
            if (age > ttl) {
                localStorage.removeItem('cache_' + key);
                return null;
            }
            
            console.log(`✓ Cache HIT: ${key} (age: ${Math.round(age / 1000)}s)`);
            return data;
        } catch (e) {
            return null;
        }
    },
    
    set(key, data) {
        try {
            localStorage.setItem('cache_' + key, JSON.stringify({
                data,
                timestamp: Date.now()
            }));
            console.log(`✓ Cache SET: ${key}`);
        } catch (e) {
            console.warn('Cache storage failed:', e);
        }
    },
    
    clear(pattern) {
        const keys = Object.keys(localStorage);
        let count = 0;
        keys.forEach(key => {
            if (key.startsWith('cache_') && (!pattern || key.includes(pattern))) {
                localStorage.removeItem(key);
                count++;
            }
        });
        if (count > 0) console.log(`✓ Cleared ${count} cache entries`);
    }
};

// Cookie helpers
function setCookie(name, value, days = 365) {
    const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}; expires=${expires}; path=/`;
}

function getCookie(name) {
    const cookie = document.cookie
        .split('; ')
        .find(row => row.startsWith(name + '='));
    
    if (cookie) {
        try {
            return JSON.parse(decodeURIComponent(cookie.split('=')[1]));
        } catch (e) {
            return null;
        }
    }
    return null;
}

function deleteCookie(name) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
}

// ============================================
// Early Global Functions for Inline Handlers
// ============================================
// Define toggleDebug early so inline onclick handlers don't fail before grades.js loads
window.toggleDebug = function (sectionId) {
    try {
        const key = 'gradeDebugOpen:' + sectionId;
        const current = localStorage.getItem(key) === '1';
        const newVal = current ? '0' : '1';
        localStorage.setItem(key, newVal);
        const btn = document.querySelector('.debug-toggle[data-section="' + sectionId + '"]');
        if (btn) {
            if (newVal === '1') btn.classList.add('active'); else btn.classList.remove('active');
        }
        const debugEl = document.getElementById('grade-debug-' + sectionId);
        if (debugEl) {
            debugEl.style.display = newVal === '1' ? 'block' : 'none';
            // If opening, ensure the course is expanded
            if (newVal === '1') {
                const courseCard = document.querySelector('.course-card[data-section="' + sectionId + '"]');
                if (courseCard) {
                    const courseContainer = courseCard.querySelector('.course-grades');
                    const header = courseContainer?.previousElementSibling;
                    if (courseContainer && courseContainer.style.display === 'none') {
                        courseContainer.style.display = 'block';
                        if (header) header.classList.add('open');
                    }
                }
            }
        }
        // Call recalculate if available
        if (typeof recalculateAllGrades === 'function') recalculateAllGrades(sectionId);
    } catch (e) { console.warn('toggleDebug error:', e); }
};

// ============================================
// Global Settings - Apply on every page
// ============================================
function getSettings() {
    try {
        const saved = localStorage.getItem('schoology_settings');
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        console.error('Error loading settings:', e);
    }
    return {
        darkMode: false,
        accentColor: 'blue',
        timeEstimates: true,
        baseMultiplier: 1.0,
        courseMultipliers: {},
        adjustDueTimes: true,
        notifyNewAssignments: true,
        notifyGrades: true,
        notifyUpdates: true,
        autoSkipCompleted: true,
        celebrationEffects: true
    };
}

function applyGlobalSettings() {
    const settings = getSettings();
    
    // Apply dark mode
    if (settings.darkMode) {
        document.documentElement.classList.add('dark-mode');
    } else {
        document.documentElement.classList.remove('dark-mode');
    }
    
    // Apply accent color
    const colors = {
        blue: '#0071e3',
        purple: '#af52de',
        green: '#34c759',
        orange: '#ff9f0a',
        red: '#ff3b30',
        pink: '#ff2d55'
    };
    document.documentElement.style.setProperty('--accent-primary', colors[settings.accentColor] || colors.blue);
    
    // Set hover color (slightly lighter)
    const hoverColors = {
        blue: '#0077ed',
        purple: '#c45ee8',
        green: '#3dd660',
        orange: '#ffaa1f',
        red: '#ff5044',
        pink: '#ff4169'
    };
    document.documentElement.style.setProperty('--accent-primary-hover', hoverColors[settings.accentColor] || hoverColors.blue);
}

// Apply settings immediately (before page renders)
applyGlobalSettings();

// Intentionally no full-page loading overlays.
// Pages should render immediately; use inline skeletons for data-dependent regions.

// Toast notifications
function showToast(message, type = 'info') {
    // Remove existing toast
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
        existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: ${type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#4a90d9'};
        color: white;
        padding: 15px 25px;
        border-radius: 8px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        z-index: 10000;
        animation: slideIn 0.3s ease;
    `;

    document.body.appendChild(toast);

    // Add animation styles
    if (!document.getElementById('toast-styles')) {
        const style = document.createElement('style');
        style.id = 'toast-styles';
        style.textContent = `
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Letter grade helper
function getLetterGrade(percentage) {
    if (percentage >= 93) return 'A';
    if (percentage >= 90) return 'A-';
    if (percentage >= 87) return 'B+';
    if (percentage >= 83) return 'B';
    if (percentage >= 80) return 'B-';
    if (percentage >= 77) return 'C+';
    if (percentage >= 73) return 'C';
    if (percentage >= 70) return 'C-';
    if (percentage >= 67) return 'D+';
    if (percentage >= 63) return 'D';
    if (percentage >= 60) return 'D-';
    return 'F';
}

// Get grade class for styling (a, b, c, d, f)
function getGradeClass(percentage) {
    if (percentage >= 90) return 'grade-a';
    if (percentage >= 80) return 'grade-b';
    if (percentage >= 70) return 'grade-c';
    if (percentage >= 60) return 'grade-d';
    return 'grade-f';
}

// Format date helper
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
        weekday: 'short', 
        month: 'short', 
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

// ============================================
// SPA Navigation + Shell -> Full Hydration
// ============================================
(function () {
    const SPA = {
        injectedStyleSelector: 'style[data-spa-style="1"]',
        injectedScriptSelector: 'script[data-spa-script="1"]',
        loadedScriptSrc: new Set(),
        navInProgress: false
    };

    // In an SPA, DOMContentLoaded only fires once on the initial hard load.
    // Many page scripts/templates still attach DOMContentLoaded listeners;
    // after an SPA swap those would never run. Patch addEventListener so
    // DOMContentLoaded handlers added post-load run immediately.
    try {
        if (!window.__schoologyUltraDomReadyPatch) {
            window.__schoologyUltraDomReadyPatch = true;

            const originalDocAdd = document.addEventListener;
            document.addEventListener = function (type, listener, options) {
                if (type === 'DOMContentLoaded' && typeof listener === 'function' && document.readyState !== 'loading') {
                    try {
                        listener.call(document, new Event('DOMContentLoaded'));
                    } catch (e) {
                        setTimeout(() => {
                            throw e;
                        }, 0);
                    }
                    return;
                }
                return originalDocAdd.call(document, type, listener, options);
            };

            const originalWinAdd = window.addEventListener;
            window.addEventListener = function (type, listener, options) {
                if (type === 'DOMContentLoaded' && typeof listener === 'function' && document.readyState !== 'loading') {
                    try {
                        listener.call(window, new Event('DOMContentLoaded'));
                    } catch (e) {
                        setTimeout(() => {
                            throw e;
                        }, 0);
                    }
                    return;
                }
                return originalWinAdd.call(window, type, listener, options);
            };
        }
    } catch {
        // ignore
    }

    // Record scripts that were already loaded on the initial hard navigation.
    try {
        Array.from(document.scripts || []).forEach((s) => {
            if (s && s.src) SPA.loadedScriptSrc.add(s.src);
        });
    } catch {
        // ignore
    }

    function isSameOrigin(url) {
        try {
            const u = new URL(url, window.location.origin);
            return u.origin === window.location.origin;
        } catch {
            return false;
        }
    }

    function shouldHandleLink(a) {
        if (!a || a.tagName !== 'A') return false;
        const href = a.getAttribute('href');
        if (!href) return false;
        if (a.hasAttribute('download')) return false;
        if (a.getAttribute('target') && a.getAttribute('target') !== '_self') return false;
        if (href.startsWith('#')) return false;
        if (href.startsWith('mailto:') || href.startsWith('tel:')) return false;
        if (a.dataset && (a.dataset.noSpa === '1' || a.dataset.noSpa === 'true')) return false;
        if (!isSameOrigin(href)) return false;

        const u = new URL(href, window.location.origin);
        // Don’t SPA-handle API endpoints
        if (u.pathname.startsWith('/api/')) return false;
        return true;
    }

    function withShellParam(url) {
        const u = new URL(url, window.location.origin);
        u.searchParams.set('shell', '1');
        // Keep URL clean in the address bar
        return u;
    }

    function stripShellParam(url) {
        const u = new URL(url, window.location.origin);
        u.searchParams.delete('shell');
        u.searchParams.delete('full');
        return u;
    }

    async function fetchHtml(url, { headers } = {}) {
        const res = await fetch(url, {
            method: 'GET',
            credentials: 'same-origin',
            headers: {
                'Accept': 'text/html',
                ...(headers || {})
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    }

    function parseHtml(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    function replacePageStyles(fromDoc) {
        document.querySelectorAll(SPA.injectedStyleSelector).forEach((el) => el.remove());
        const styles = Array.from(fromDoc.querySelectorAll('head style'));
        styles.forEach((styleEl) => {
            const next = document.createElement('style');
            next.setAttribute('data-spa-style', '1');
            next.textContent = styleEl.textContent || '';
            document.head.appendChild(next);
        });
    }

    function replaceBodyContent(fromDoc) {
        // Remove scripts from the incoming body so we can execute them explicitly.
        const scripts = Array.from(fromDoc.body.querySelectorAll('script'));
        scripts.forEach((s) => s.remove());

        // Copy body attributes (including data-shell) and content
        const incoming = fromDoc.body;
        document.body.className = incoming.className || '';
        // Preserve existing dataset keys but overwrite with incoming
        Object.keys(document.body.dataset).forEach((k) => delete document.body.dataset[k]);
        Object.keys(incoming.dataset || {}).forEach((k) => {
            document.body.dataset[k] = incoming.dataset[k];
        });

        document.body.innerHTML = incoming.innerHTML;
        return scripts;
    }

    function loadScript(src, { type } = {}) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.setAttribute('data-spa-script', '1');
            if (type) el.type = type;
            el.src = src;
            el.async = false;
            el.onload = () => resolve();
            el.onerror = (e) => reject(e);
            document.body.appendChild(el);
        });
    }

    function runInlineScript(code, { type } = {}) {
        const el = document.createElement('script');
        el.setAttribute('data-spa-script', '1');
        if (type) el.type = type;
        el.text = code || '';
        document.body.appendChild(el);
    }

    async function injectPageScripts(scripts) {
        // Remove previously injected scripts (from prior SPA navigations)
        document.querySelectorAll(SPA.injectedScriptSelector).forEach((el) => el.remove());

        for (const s of scripts) {
            const src = s.getAttribute('src');
            const type = s.getAttribute('type') || undefined;

            // Never re-inject the global SPA script itself; it already runs.
            if (src && src.includes('/js/app.js')) continue;

            // Analytics should run once per real page load. Skip re-injection.
            if (src && src.includes('/js/analytics.js')) continue;

            // Particles/effects are global-ish and can duplicate visuals if re-run.
            if (src && src.includes('/js/particles.js')) continue;
            if (src && src.includes('/js/effects.js')) continue;

            if (src) {
                // If already loaded earlier in this session, don't re-execute; rely on spa:load hooks.
                if (SPA.loadedScriptSrc.has(src)) continue;
                await loadScript(src, { type });
                SPA.loadedScriptSrc.add(src);
            } else {
                const code = s.textContent;
                if (code && code.trim()) runInlineScript(code, { type });
            }
        }

        // Let page-level scripts re-init without relying on native DOMContentLoaded.
        try {
            window.dispatchEvent(new Event('spa:load'));
        } catch (e) {
            // ignore
        }
    }

    function updateTitle(fromDoc) {
        if (fromDoc && typeof fromDoc.title === 'string' && fromDoc.title.trim()) {
            document.title = fromDoc.title;
        }
    }

    function updateNavActive(pathname) {
        const links = document.querySelectorAll('.nav-link, .nav-icon-link');
        links.forEach((el) => el.classList.remove('active'));
        links.forEach((el) => {
            const href = el.getAttribute('href');
            if (!href) return;
            try {
                const u = new URL(href, window.location.origin);
                if (u.pathname === pathname) el.classList.add('active');
            } catch {
                // ignore
            }
        });
    }

    async function applyHtmlToPage(html) {
        const doc = parseHtml(html);
        updateTitle(doc);
        replacePageStyles(doc);
        const scripts = replaceBodyContent(doc);
        updateNavActive(window.location.pathname);
        await injectPageScripts(scripts);
    }

    async function spaNavigate(targetUrl, { replace = false } = {}) {
        if (SPA.navInProgress) return;
        SPA.navInProgress = true;
        const cleanUrl = stripShellParam(targetUrl);
        const shellUrl = withShellParam(cleanUrl);

        const previousUrl = window.location.href;

        // Update the address bar immediately (no browser navigation)
        if (replace) history.replaceState({}, '', cleanUrl);
        else history.pushState({}, '', cleanUrl);

        try {
            let shellApplied = false;

            // 1) Paint shell instantly (fast). If this fails, still try full.
            try {
                const shellHtml = await fetchHtml(shellUrl.toString(), {
                    headers: { 'X-Shell': '1' }
                });
                await applyHtmlToPage(shellHtml);
                shellApplied = true;
            } catch {
                // ignore shell failure
            }

            // 2) Hydrate to full render
            try {
                const fullHtml = await fetchHtml(cleanUrl.toString(), {
                    headers: { 'X-Full-Render': '1' }
                });
                await applyHtmlToPage(fullHtml);
            } catch (e) {
                // If we already swapped to shell, keep it and show a toast.
                if (shellApplied) {
                    try {
                        showToast('Some content failed to load. Retry in a moment.', 'error');
                    } catch {
                        // ignore
                    }
                } else {
                    // No shell and no full: revert URL and stay put.
                    try {
                        history.replaceState({}, '', previousUrl);
                    } catch {
                        // ignore
                    }
                    try {
                        showToast('Navigation failed. Please try again.', 'error');
                    } catch {
                        // ignore
                    }
                }
            }
        } finally {
            SPA.navInProgress = false;
        }
    }

    async function hydrateIfShell() {
        try {
            if (!document.body) {
                console.log('[SPA] No body element, skipping hydration');
                return;
            }
            
            const shellAttr = document.body.getAttribute('data-shell');
            console.log('[SPA] data-shell attribute:', shellAttr);
            
            if (shellAttr !== '1') {
                console.log('[SPA] Not a shell page, skipping hydration');
                return;
            }

            console.log('[SPA] Shell detected, starting hydration...');
            const cleanUrl = stripShellParam(window.location.href);
            console.log('[SPA] Fetching full render from:', cleanUrl.toString());
            
            const fullHtml = await fetchHtml(cleanUrl.toString(), {
                headers: { 'X-Full-Render': '1' }
            });
            
            console.log('[SPA] Full HTML received, applying to page...');
            await applyHtmlToPage(fullHtml);
            console.log('[SPA] Hydration complete!');
        } catch (e) {
            console.error('[SPA] Hydration failed:', e);
            try {
                showToast('Some content failed to load. Refresh to retry.', 'error');
            } catch {
                // ignore
            }
        }
    }

    // Link interception
    document.addEventListener('click', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!shouldHandleLink(a)) return;
        // Only plain left-click
        if (e.defaultPrevented) return;
        if (e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

        console.log('[SPA] Intercepting navigation to:', a.href);
        e.preventDefault();
        spaNavigate(a.href);
    });

    // Back/forward
    window.addEventListener('popstate', () => {
        spaNavigate(window.location.href, { replace: true });
    });

    // Allow inline scripts/templates to trigger SPA navigation.
    // (Fallback to normal navigation if SPA is unavailable.)
    try {
        window.__spaNavigate = (url, opts) => spaNavigate(url, opts);
    } catch {
        // ignore
    }

    console.log('[SPA] Initializing... readyState:', document.readyState);
    if (document.readyState === 'loading') {
        console.log('[SPA] Waiting for DOMContentLoaded...');
        document.addEventListener('DOMContentLoaded', () => {
            console.log('[SPA] DOMContentLoaded fired, checking for shell...');
            hydrateIfShell();
        });
    } else {
        console.log('[SPA] DOM already ready, checking for shell...');
        hydrateIfShell();
    }
})();

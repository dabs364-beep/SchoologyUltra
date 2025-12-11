// ============================================================
// Vercel Web Analytics Integration
// ============================================================
// Initializes Vercel Web Analytics for tracking page performance
// and user interactions across the Schoology Pro Max application.
//
// This module handles client-side analytics injection using
// the @vercel/analytics package.

(function() {
    // Only initialize on client-side in browser environment
    if (typeof window === 'undefined') {
        return;
    }

    /**
     * Initialize Vercel Web Analytics
     * This function sets up web analytics to track:
     * - Page views and navigation
     * - Core Web Vitals (CLS, FID, LCP)
     * - Performance metrics
     */
    function initializeAnalytics() {
        try {
            // Dynamically load the analytics module
            const script = document.createElement('script');
            script.src = 'https://cdn.vercel-analytics.com/v1/web.js';
            script.async = true;
            
            // Mark success when script loads
            script.onload = function() {
                console.log('✓ Vercel Web Analytics loaded successfully');
                
                // Call the inject function if available
                if (window.va && typeof window.va.inject === 'function') {
                    window.va.inject();
                    console.log('✓ Vercel Web Analytics injected');
                }
            };
            
            // Handle script load errors gracefully
            script.onerror = function() {
                console.warn('⚠️  Failed to load Vercel Web Analytics');
            };
            
            // Insert script into document head
            document.head.appendChild(script);
        } catch (e) {
            console.warn('Error initializing Vercel Web Analytics:', e.message);
        }
    }

    // Initialize analytics when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeAnalytics);
    } else {
        // DOM is already ready
        initializeAnalytics();
    }
})();

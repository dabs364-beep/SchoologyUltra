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

// Loading screen for link navigation
function showLoadingOnNavigate() {
    document.querySelectorAll('a[href^="/"]').forEach(link => {
        // Skip links that should open in new tabs or are hash links
        if (link.target === '_blank' || link.href.includes('#')) return;
        
        link.addEventListener('click', function(e) {
            // Skip if it's a modifier key click
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            
            // Create and show loading overlay
            const overlay = document.createElement('div');
            overlay.className = 'loading-overlay';
            overlay.innerHTML = `
                <div class="loading-content">
                    <div class="loading-spinner"></div>
                    <div class="loading-text">Loading...</div>
                </div>
            `;
            document.body.appendChild(overlay);
        });
    });
}

// Initialize loading behavior on page load
document.addEventListener('DOMContentLoaded', function() {
    showLoadingOnNavigate();
});

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

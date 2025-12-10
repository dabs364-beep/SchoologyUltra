require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');
const path = require('path');

// ============================================================
// Vercel Deployment Configuration
// ============================================================
// Detect if running on Vercel (serverless environment)
const IS_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL_ENV !== undefined;

// Conditionally require fs only for local development
const fs = IS_VERCEL ? null : require('fs');

// Browser features configuration
let BROWSER_FEATURES_ENABLED = process.env.ENABLE_BROWSER !== 'false';
let chromium = null;
let chromiumPack = null; // For Vercel

if (IS_VERCEL) {
    try {
        // Try to load Vercel-compatible chromium
        chromium = require('playwright-core').chromium;
        chromiumPack = require('@sparticuz/chromium');
        console.log('✓ Vercel Chromium setup loaded');
    } catch (e) {
        console.log('⚠️  Vercel Chromium dependencies not found. Install @sparticuz/chromium and playwright-core to enable.');
        BROWSER_FEATURES_ENABLED = false;
    }
} else {
    // Local development
    try {
        chromium = require('playwright').chromium;
    } catch (e) {
        console.log('⚠️  Playwright not available - browser features disabled');
        BROWSER_FEATURES_ENABLED = false;
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Enable response compression for 3x faster transfers
try {
    const compression = require('compression');
    app.use(compression({
        level: 6,
        threshold: 1024,
        filter: (req, res) => {
            if (req.headers['x-no-compression']) return false;
            return compression.filter(req, res);
        }
    }));
    debugLog('SERVER', '✓ Compression enabled');
} catch (e) {
    debugLog('SERVER', '⚠️  Compression not available (run: npm install compression)');
}

// Enable response compression for faster transfers
const compression = require('compression');
app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }
}));

// ============================================================
// Cookie Encryption for Serverless OAuth Token Storage
// ============================================================
// On Vercel, sessions don't persist between requests, so we store
// OAuth request tokens in encrypted cookies instead

const ENCRYPTION_KEY = crypto.createHash('sha256')
    .update(process.env.SESSION_SECRET || 'schoology-pro-max-secret')
    .digest();
const IV_LENGTH = 16;

function encryptToken(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptToken(text) {
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = parts[1];
        const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return null;
    }
}

// Browser session management (only used when browser features enabled)
let browserContext = null;
let browserInstance = null;
let isLoggedIn = false;

// Storage paths (only used locally, not on Vercel)
const BROWSER_STATE_PATH = path.join(__dirname, '.browser-state');
const NOTIFICATIONS_PATH = path.join(__dirname, '.notifications.json');
const SCHEDULE_PATH = path.join(__dirname, '.schedule.json');

// In-memory caches (works on both local and Vercel)
// Note: On Vercel, these reset between function invocations
let notificationsCache = {};
let scheduleCache = {};

// ============================================================
// API Response Cache System for Faster Page Loads
// ============================================================

// Comprehensive caching system for 3x+ performance boost
const apiCache = new Map();
const CACHE_TTL = {
    sections: 5 * 60 * 1000,      // 5 minutes
    grades: 2 * 60 * 1000,        // 2 minutes
    assignments: 3 * 60 * 1000,   // 3 minutes
    user: 10 * 60 * 1000,         // 10 minutes
    courses: 5 * 60 * 1000,       // 5 minutes
    categories: 10 * 60 * 1000,   // 10 minutes (rarely changes)
    submissions: 1 * 60 * 1000    // 1 minute (updates frequently)
};

function getCacheKey(userId, endpoint, params = {}) {
    const paramStr = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return `${userId}:${endpoint}:${paramStr}`;
}

function getCachedData(key, ttl = 5 * 60 * 1000) {
    const cached = apiCache.get(key);
    if (!cached) return null;
    
    const age = Date.now() - cached.timestamp;
    if (age > ttl) {
        apiCache.delete(key);
        return null;
    }
    
    debugLog('CACHE', `✓ Cache HIT: ${key} (age: ${Math.round(age / 1000)}s)`);
    return cached.data;
}

function setCachedData(key, data) {
    apiCache.set(key, {
        data,
        timestamp: Date.now()
    });
    debugLog('CACHE', `✓ Cache SET: ${key}`);
}

function invalidateCache(pattern) {
    let count = 0;
    for (const key of apiCache.keys()) {
        if (key.includes(pattern)) {
            apiCache.delete(key);
            count++;
        }
    }
    if (count > 0) debugLog('CACHE', `✓ Invalidated ${count} cache entries matching: ${pattern}`);
}

// Clear specific cache for a user
function clearCache(userId, cacheKey) {
    invalidateCache(`${userId}:${cacheKey}`);
}

// Clear all cache for a user
function clearAllCache(userId) {
    invalidateCache(userId);
}

// ============================================================
// Optimized API Fetching Functions
// ============================================================

// Fetch all sections with caching
async function fetchAllSectionsOptimized(userId, accessToken) {
    const cacheKey = getCacheKey(userId, 'sections');
    const cached = getCachedData(cacheKey, CACHE_TTL.sections);
    if (cached) {
        // Cache may contain either the raw API response or the processed array.
        // Normalize both shapes to always return an array of sections.
        if (Array.isArray(cached)) return cached;
        if (cached && typeof cached === 'object' && Array.isArray(cached.section)) return cached.section;
        // If cached is unexpected shape, fall through and re-fetch.
    }

    const sectionsUrl = `${config.apiBase}/users/${userId}/sections?limit=200`;
    debugLog('FETCH', `📚 Fetching sections from: ${sectionsUrl}`);

    try {
        const sectionsData = await makeOAuthRequest('GET', sectionsUrl, accessToken, null, {
            cache: true,
            cacheKey,
            cacheTTL: CACHE_TTL.sections
        });

        const sections = sectionsData && Array.isArray(sectionsData.section) ? sectionsData.section : [];
        debugLog('FETCH', `✓ Found ${sections.length} sections`);

        // Store the processed array in cache to keep later reads consistent
        try {
            setCachedData(cacheKey, sections);
        } catch (e) {
            debugLog('CACHE', `Could not set sections cache: ${e.message}`);
        }

        return sections;
    } catch (e) {
        debugLog('FETCH-ERROR', `Failed to fetch sections: ${e.message}`);
        throw e;
    }
}

// Fetch all grades with caching
async function fetchAllGradesOptimized(userId, accessToken) {
    const cacheKey = getCacheKey(userId, 'grades');
    const cached = getCachedData(cacheKey, CACHE_TTL.grades);
    if (cached) return cached;

    const gradesUrl = `${config.apiBase}/users/${userId}/grades?with_category_grades=1`;
    debugLog('FETCH', `📊 Fetching grades from: ${gradesUrl}`);

    const gradesData = await makeOAuthRequest('GET', gradesUrl, accessToken, null, {
        cache: true,
        cacheKey,
        cacheTTL: CACHE_TTL.grades
    });

    debugLog('FETCH', `✓ Grades fetched successfully`);
    return gradesData;
}

// Fetch assignments for multiple sections in parallel with caching
async function fetchAssignmentsForSectionsParallel(sectionIds, accessToken, maxConcurrent = 5, userId = null) {
    const results = {};

    // Process in batches to avoid overwhelming the API
    for (let i = 0; i < sectionIds.length; i += maxConcurrent) {
        const batch = sectionIds.slice(i, i + maxConcurrent);

        const batchPromises = batch.map(async (sectionId) => {
            try {
                const assignments = await fetchAllAssignments(sectionId, accessToken, userId);
                return { sectionId, assignments, error: null };
            } catch (e) {
                return { sectionId, assignments: [], error: e.message };
            }
        });

        const batchResults = await Promise.all(batchPromises);

        for (const result of batchResults) {
            results[result.sectionId] = {
                assignments: result.assignments,
                error: result.error
            };
        }
    }

    return results;
}

// Fetch grading categories for multiple sections in parallel
async function fetchCategoriesForSectionsParallel(sectionIds, accessToken, maxConcurrent = 5, userId = null) {
    const results = {};

    for (let i = 0; i < sectionIds.length; i += maxConcurrent) {
        const batch = sectionIds.slice(i, i + maxConcurrent);

        const batchPromises = batch.map(async (sectionId) => {
            try {
                const categoriesUrl = `${config.apiBase}/sections/${sectionId}/grading_categories`;
                const categoriesData = await makeOAuthRequest('GET', categoriesUrl, accessToken, null, {
                    cache: !!userId,
                    cacheKey: userId ? getCacheKey(userId, `categories-${sectionId}`) : null,
                    cacheTTL: CACHE_TTL.categories
                });
                return { sectionId, categories: categoriesData.grading_category || [], error: null };
            } catch (e) {
                return { sectionId, categories: [], error: e.message };
            }
        });

        const batchResults = await Promise.all(batchPromises);

        for (const result of batchResults) {
            results[result.sectionId] = {
                categories: result.categories,
                error: result.error
            };
        }
    }

    return results;
}

// Fetch grades for a specific section
async function fetchSectionGrades(sectionId, accessToken) {
    try {
        const gradesUrl = `${config.apiBase}/sections/${sectionId}/grades`;
        debugLog('API', `Fetching section grades: ${gradesUrl}`);
        const gradesData = await makeOAuthRequest('GET', gradesUrl, accessToken);
        return gradesData;
    } catch (e) {
        debugLog('API', `Failed to fetch section grades: ${e.message}`);
        return null;
    }
}

// Parse grades into a lookup map by assignment_id
function parseGradesIntoMap(gradesData) {
    const gradesMap = {};
    const sectionGrades = {};
    const sectionGradeData = {};

    if (gradesData && gradesData.section) {
        for (const sec of gradesData.section) {
            const sectionId = sec.section_id;
            let finalGrade = null;

            // Extract final_grade
            if (sec.final_grade !== undefined && sec.final_grade !== null && sec.final_grade !== '') {
                if (Array.isArray(sec.final_grade) && sec.final_grade.length > 0) {
                    const fg = sec.final_grade[0];
                    if (fg.grade !== undefined) {
                        const parsed = parseFloat(fg.grade);
                        if (!isNaN(parsed)) finalGrade = parsed;
                    }
                } else {
                    const parsed = parseFloat(sec.final_grade);
                    if (!isNaN(parsed)) finalGrade = parsed;
                }
            }

            sectionGrades[sectionId] = finalGrade;
            sectionGradeData[sectionId] = sec;

            // Parse individual assignment grades
            const periods = sec.period || [];
            for (const period of periods) {
                const assignments = period.assignment || [];
                for (const grade of assignments) {
                    // Inject section_id into the grade object for reverse lookup
                    grade._section_id = sectionId;
                    gradesMap[grade.assignment_id] = grade;
                }
            }
        }
    }

    return { gradesMap, sectionGrades, sectionGradeData };
}

// Load schedule from disk (or just return cache on Vercel)
function loadSchedule(userId) {
    // On Vercel, we can't persist to filesystem, just use in-memory cache
    if (IS_VERCEL) {
        return scheduleCache[userId] || {};
    }

    try {
        if (fs && fs.existsSync(SCHEDULE_PATH)) {
            const data = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
            scheduleCache = data;
        }
    } catch (e) {
        debugLog('SCHEDULE', `Error loading schedule: ${e.message}`);
    }
    return scheduleCache[userId] || {};
}

// Save schedule to disk (or just cache on Vercel)
function saveSchedule(userId, schedule) {
    // Always update in-memory cache
    if (!scheduleCache[userId]) {
        scheduleCache[userId] = {};
    }
    scheduleCache[userId] = schedule;

    // On Vercel or if fs is not available, skip filesystem write
    if (IS_VERCEL || !fs) {
        return;
    }

    try {
        fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(scheduleCache, null, 2));
    } catch (e) {
        debugLog('SCHEDULE', `Error saving schedule: ${e.message}`);
    }
}

// Get class start time for a section on a specific day of week (1=Monday, 5=Friday)
function getClassStartTime(userId, sectionId, dayOfWeek) {
    const schedule = scheduleCache[userId] || {};
    const dayBlocks = schedule[dayOfWeek] || [];

    for (const block of dayBlocks) {
        if (block.sectionId === sectionId) {
            return {
                hour: block.startHour,
                minute: block.startMinute
            };
        }
    }
    return null;
}

// ============================================================
// AI-Powered Assignment Time Estimation
// ============================================================

// Estimate time to complete an assignment based on various factors
function estimateAssignmentTime(assignment) {
    const title = (assignment.title || '').toLowerCase();
    const courseName = (assignment.course_name || '').toLowerCase();
    const type = assignment.type || 'assignment';
    const maxPoints = parseFloat(assignment.max_points) || 0;
    const description = (assignment.description || '').toLowerCase();

    let baseMinutes = 15; // Default base time
    let multiplier = 1.0;
    let confidence = 'medium';

    // === TYPE-BASED ESTIMATION ===
    if (type === 'assessment' || type === 'assessment_v2') {
        // Quiz/Test
        baseMinutes = 25;
        confidence = 'high';
    } else if (type === 'discussion') {
        baseMinutes = 20;
    }

    // === KEYWORD-BASED ADJUSTMENTS ===
    const keywords = {
        // High-effort keywords (long tasks)
        'project': { add: 60, mult: 1.5 },
        'essay': { add: 45, mult: 1.3 },
        'research': { add: 40, mult: 1.3 },
        'presentation': { add: 40, mult: 1.2 },
        'lab report': { add: 35, mult: 1.2 },
        'lab': { add: 30, mult: 1.1 },
        'write': { add: 20, mult: 1.2 },
        'writing': { add: 20, mult: 1.2 },
        'analysis': { add: 25, mult: 1.2 },
        'analyze': { add: 25, mult: 1.2 },

        // Medium-effort keywords
        'frq': { add: 20, mult: 1.1 },
        'free response': { add: 20, mult: 1.1 },
        'worksheet': { add: 10, mult: 1.0 },
        'practice': { add: 5, mult: 0.9 },
        'review': { add: 5, mult: 0.9 },
        'homework': { add: 10, mult: 1.0 },
        'hw': { add: 10, mult: 1.0 },
        'assignment': { add: 5, mult: 1.0 },
        'problems': { add: 15, mult: 1.0 },
        'exercises': { add: 10, mult: 1.0 },

        // Low-effort keywords (quick tasks)
        'quiz': { add: 0, mult: 0.8 },
        'check': { add: -5, mult: 0.7 },
        'survey': { add: -10, mult: 0.5 },
        'intro': { add: -5, mult: 0.7 },
        'syllabus': { add: -10, mult: 0.5 },
        'sign': { add: -10, mult: 0.4 },
        'acknowledgment': { add: -10, mult: 0.3 },
        'form': { add: -10, mult: 0.5 },

        // Reading-based
        'reading': { add: 20, mult: 1.0 },
        'read': { add: 15, mult: 1.0 },
        'chapter': { add: 25, mult: 1.1 },
        'article': { add: 15, mult: 1.0 },

        // Test/Exam related
        'test': { add: 30, mult: 1.3 },
        'exam': { add: 40, mult: 1.4 },
        'final': { add: 50, mult: 1.5 },
        'midterm': { add: 45, mult: 1.4 },
        'unit': { add: 15, mult: 1.1 },

        // Video-based
        'video': { add: 15, mult: 0.9 },
        'watch': { add: 10, mult: 0.8 },
        'edpuzzle': { add: 15, mult: 0.9 },

        // Coding/Tech
        'code': { add: 25, mult: 1.2 },
        'coding': { add: 25, mult: 1.2 },
        'program': { add: 30, mult: 1.2 },
        'programming': { add: 30, mult: 1.2 },
        'java': { add: 20, mult: 1.1 },
        'python': { add: 20, mult: 1.1 },
    };

    // Check title and description for keywords
    let keywordMatches = [];
    for (const [keyword, adjustment] of Object.entries(keywords)) {
        if (title.includes(keyword) || description.includes(keyword)) {
            keywordMatches.push({ keyword, ...adjustment });
        }
    }

    // Apply the most impactful keyword adjustment
    if (keywordMatches.length > 0) {
        // Sort by impact (add value)
        keywordMatches.sort((a, b) => Math.abs(b.add) - Math.abs(a.add));
        const primary = keywordMatches[0];
        baseMinutes += primary.add;
        multiplier *= primary.mult;
        confidence = 'high';
    }

    // === SUBJECT-BASED ADJUSTMENTS ===
    const subjectMultipliers = {
        'ap ': 1.3,
        'honors': 1.2,
        'advanced': 1.2,
        'math': 1.1,
        'calculus': 1.2,
        'physics': 1.2,
        'chemistry': 1.15,
        'biology': 1.1,
        'history': 1.1,
        'english': 1.1,
        'language': 1.0,
        'art': 0.9,
        'pe': 0.7,
        'health': 0.8,
    };

    for (const [subject, mult] of Object.entries(subjectMultipliers)) {
        if (courseName.includes(subject)) {
            multiplier *= mult;
            break;
        }
    }

    // === POINT-BASED ADJUSTMENTS ===
    // More points generally = more work
    if (maxPoints > 0) {
        if (maxPoints <= 5) {
            multiplier *= 0.6; // Quick task
        } else if (maxPoints <= 10) {
            multiplier *= 0.8;
        } else if (maxPoints <= 20) {
            multiplier *= 0.9;
        } else if (maxPoints <= 50) {
            multiplier *= 1.0;
        } else if (maxPoints <= 100) {
            multiplier *= 1.2;
        } else {
            multiplier *= 1.4; // Big assignment
        }
    }

    // Calculate final time
    let estimatedMinutes = Math.round(baseMinutes * multiplier);

    // Clamp to reasonable bounds
    estimatedMinutes = Math.max(5, Math.min(180, estimatedMinutes));

    // Format the time string
    let timeString;
    if (estimatedMinutes < 60) {
        timeString = `${estimatedMinutes}m`;
    } else {
        const hours = Math.floor(estimatedMinutes / 60);
        const mins = estimatedMinutes % 60;
        timeString = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    }

    return {
        minutes: estimatedMinutes,
        display: timeString,
        confidence: confidence
    };
}

// Add time estimates to an array of assignments
function addTimeEstimates(assignments) {
    return assignments.map(a => ({
        ...a,
        estimatedTime: estimateAssignmentTime(a)
    }));
}

// Load notifications from disk (or just return cache on Vercel)
function loadNotifications(userId) {
    // On Vercel, we can't persist to filesystem, just use in-memory cache
    if (IS_VERCEL) {
        return notificationsCache[userId] || { notifications: [], knownAssignments: {}, knownGrades: {} };
    }

    try {
        if (fs && fs.existsSync(NOTIFICATIONS_PATH)) {
            const data = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8'));
            notificationsCache = data;
        }
    } catch (e) {
        debugLog('NOTIFICATIONS', `Error loading notifications: ${e.message}`);
    }
    return notificationsCache[userId] || { notifications: [], knownAssignments: {}, knownGrades: {} };
}

// Save notifications to disk (or just cache on Vercel)
function saveNotifications() {
    // On Vercel, skip filesystem write
    if (IS_VERCEL) {
        return;
    }

    try {
        if (fs) {
            fs.writeFileSync(NOTIFICATIONS_PATH, JSON.stringify(notificationsCache, null, 2));
        }
    } catch (e) {
        debugLog('NOTIFICATIONS', `Error saving notifications: ${e.message}`);
    }
}

// Add a notification
function addNotification(userId, notification) {
    if (!notificationsCache[userId]) {
        notificationsCache[userId] = { notifications: [], knownAssignments: {}, knownGrades: {} };
    }

    // Check for duplicates
    const exists = notificationsCache[userId].notifications.some(
        n => n.assignmentId === notification.assignmentId && n.type === notification.type
    );

    if (!exists) {
        notification.id = crypto.randomBytes(8).toString('hex');
        notification.read = false;
        notification.timestamp = new Date().toISOString();
        notificationsCache[userId].notifications.unshift(notification);

        // Keep only last 100 notifications
        if (notificationsCache[userId].notifications.length > 100) {
            notificationsCache[userId].notifications = notificationsCache[userId].notifications.slice(0, 100);
        }

        saveNotifications();
        return true;
    }
    return false;
}

// Check if browser is ready and logged in
function isBrowserReady() {
    // Browser features are disabled on Vercel
    if (!BROWSER_FEATURES_ENABLED) {
        return false;
    }
    return browserInstance !== null && browserContext !== null && isLoggedIn;
}

// Configuration
const config = {
    consumerKey: process.env.SCHOOLOGY_CONSUMER_KEY,
    consumerSecret: process.env.SCHOOLOGY_CONSUMER_SECRET,
    domain: process.env.SCHOOLOGY_DOMAIN || 'app.schoology.com',
    apiBase: 'https://api.schoology.com/v1'
};

// Debug logging helper
function debugLog(category, message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${category}]`;
    if (data) {
        console.log(`${prefix} ${message}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
    } else {
        console.log(`${prefix} ${message}`);
    }
}

// Startup validation
debugLog('CONFIG', 'Validating configuration...');
if (!config.consumerKey || config.consumerKey === 'your_consumer_key_here') {
    debugLog('CONFIG', '⚠️  WARNING: SCHOOLOGY_CONSUMER_KEY is not set or using default value!');
} else {
    debugLog('CONFIG', `✓ Consumer Key: ${config.consumerKey.substring(0, 8)}...`);
}
if (!config.consumerSecret || config.consumerSecret === 'your_consumer_secret_here') {
    debugLog('CONFIG', '⚠️  WARNING: SCHOOLOGY_CONSUMER_SECRET is not set or using default value!');
} else {
    debugLog('CONFIG', `✓ Consumer Secret: ${config.consumerSecret.substring(0, 8)}...`);
}
debugLog('CONFIG', `✓ Domain: ${config.domain}`);
debugLog('CONFIG', `✓ API Base: ${config.apiBase}`);

// OAuth 1.0a Helper Functions
function generateNonce() {
    return crypto.randomBytes(16).toString('hex');
}

function generateTimestamp() {
    return Math.floor(Date.now() / 1000).toString();
}

function percentEncode(str) {
    return encodeURIComponent(str).replace(/[!'()*]/g, function (c) {
        return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
}

function generateSignatureBaseString(method, url, params) {
    // Parse URL to get base URL and query parameters
    const urlObj = new URL(url);
    const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;

    // Include query parameters from the URL in the signature
    const allParams = { ...params };
    urlObj.searchParams.forEach((value, key) => {
        allParams[key] = value;
    });

    // Sort parameters alphabetically and build param string
    const sortedKeys = Object.keys(allParams).sort();
    const paramString = sortedKeys.map(key => `${percentEncode(key)}=${percentEncode(allParams[key])}`).join('&');

    return `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(paramString)}`;
}

function generateSignature(baseString, consumerSecret, tokenSecret = '') {
    const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
    const hmac = crypto.createHmac('sha1', signingKey);
    hmac.update(baseString);
    return hmac.digest('base64');
}

function buildAuthorizationHeader(params) {
    const headerParts = Object.keys(params)
        .filter(key => key.startsWith('oauth_'))
        .sort()
        .map(key => `${percentEncode(key)}="${percentEncode(params[key])}"`)
        .join(', ');

    return `OAuth realm="", ${headerParts}`;
}

function makeOAuthRequest(method, url, token = null, body = null, cacheOptions = {}) {
    return new Promise((resolve, reject) => {
        // Check cache first if enabled
        if (cacheOptions.cache && cacheOptions.cacheKey) {
            const cached = getCachedData(cacheOptions.cacheKey, cacheOptions.cacheTTL || 5 * 60 * 1000);
            if (cached) {
                resolve(cached);
                return;
            }
        }

        debugLog('OAUTH-REQUEST', `Starting ${method} request to: ${url}`);

        const oauthParams = {
            oauth_consumer_key: config.consumerKey,
            oauth_nonce: generateNonce(),
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: generateTimestamp(),
            oauth_version: '1.0'
        };

        // Only include oauth_token if we have one
        if (token && token.oauth_token) {
            oauthParams.oauth_token = token.oauth_token;
        }

        debugLog('OAUTH-REQUEST', 'OAuth parameters:', {
            oauth_consumer_key: oauthParams.oauth_consumer_key ? oauthParams.oauth_consumer_key.substring(0, 8) + '...' : 'NOT SET',
            oauth_nonce: oauthParams.oauth_nonce,
            oauth_timestamp: oauthParams.oauth_timestamp,
            oauth_token: oauthParams.oauth_token ? oauthParams.oauth_token.substring(0, 8) + '...' : '(not included)',
            oauth_signature_method: oauthParams.oauth_signature_method
        });

        // Generate signature
        const tokenSecret = token ? token.oauth_token_secret : '';
        const baseString = generateSignatureBaseString(method, url, oauthParams);
        debugLog('OAUTH-REQUEST', 'Signature base string:', baseString.substring(0, 100) + '...');

        oauthParams.oauth_signature = generateSignature(baseString, config.consumerSecret, tokenSecret);
        debugLog('OAUTH-REQUEST', 'Generated signature:', oauthParams.oauth_signature);

        const authHeader = buildAuthorizationHeader(oauthParams);
        debugLog('OAUTH-REQUEST', 'Authorization header:', authHeader.substring(0, 80) + '...');

        const urlObj = new URL(url);

        // Generate a mobile session cookie (mimics Schoology mobile app)
        const sessionCookie = `s_mobile=${crypto.randomBytes(16).toString('hex')}`;

        const requestOptions = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname + urlObj.search,
            method: method,
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Schoology/1 CFNetwork/3860.100.1 Darwin/25.0.0',
                'Cookie': sessionCookie,
                'Connection': 'keep-alive',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br'
            }
        };

        debugLog('OAUTH-REQUEST', 'Request headers:', {
            'User-Agent': requestOptions.headers['User-Agent'],
            'Cookie': requestOptions.headers['Cookie']
        });

        const req = https.request(requestOptions, (res) => {
            debugLog('OAUTH-RESPONSE', `Response status: ${res.statusCode} ${res.statusMessage}`);
            debugLog('OAUTH-RESPONSE', 'Response headers:', res.headers);

            // Handle compressed responses
            let responseStream = res;
            const encoding = res.headers['content-encoding'];

            if (encoding === 'gzip') {
                responseStream = res.pipe(zlib.createGunzip());
            } else if (encoding === 'deflate') {
                responseStream = res.pipe(zlib.createInflate());
            } else if (encoding === 'br') {
                responseStream = res.pipe(zlib.createBrotliDecompress());
            }

            let chunks = [];
            responseStream.on('data', chunk => chunks.push(chunk));
            responseStream.on('end', () => {
                const data = Buffer.concat(chunks).toString('utf8');
                debugLog('OAUTH-RESPONSE', `Response body (${data.length} bytes):`, data.substring(0, 500));

                // Handle redirects manually (need new nonce/timestamp for each)
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    debugLog('OAUTH-RESPONSE', `Following redirect to: ${res.headers.location}`);
                    const redirectUrl = res.headers.location.startsWith('http')
                        ? res.headers.location
                        : `https://${urlObj.hostname}${res.headers.location}`;
                    makeOAuthRequest(method, redirectUrl, token, body, cacheOptions)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                if (res.statusCode >= 400) {
                    debugLog('OAUTH-ERROR', `HTTP Error ${res.statusCode}: ${data}`);
                    reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                    return;
                }

                // Check if response is HTML (indicates auth failure or wrong endpoint)
                if (data.trim().startsWith('<!') || data.trim().startsWith('<html') || data.trim().startsWith('<HTML')) {
                    debugLog('OAUTH-ERROR', 'Received HTML instead of JSON - likely auth failure');
                    debugLog('OAUTH-ERROR', 'HTML content:', data.substring(0, 300));
                    reject(new Error('API returned HTML instead of JSON. This usually means authentication failed or the endpoint is incorrect.'));
                    return;
                }

                // Try to parse as JSON, otherwise return as string
                try {
                    const parsed = JSON.parse(data);
                    debugLog('OAUTH-RESPONSE', '✓ Successfully parsed JSON response');
                    
                    // Cache the response if caching is enabled
                    if (cacheOptions.cache && cacheOptions.cacheKey) {
                        setCachedData(cacheOptions.cacheKey, parsed);
                    }
                    
                    resolve(parsed);
                } catch (e) {
                    debugLog('OAUTH-RESPONSE', '✓ Returning raw string response');
                    
                    // Cache raw response too if caching is enabled
                    if (cacheOptions.cache && cacheOptions.cacheKey) {
                        setCachedData(cacheOptions.cacheKey, data);
                    }
                    
                    resolve(data);
                }
            });
        });

        req.on('error', (err) => {
            debugLog('OAUTH-ERROR', `Request error: ${err.message}`);
            reject(err);
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Session configuration - optimized for both local and Vercel
// Note: On Vercel serverless, sessions are stored in-memory which doesn't persist
// For production, consider using a Redis-based session store
app.use(session({
    secret: process.env.SESSION_SECRET || 'schoology-pro-max-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
        httpOnly: true,
        secure: IS_VERCEL, // Use secure cookies on Vercel (HTTPS)
        sameSite: IS_VERCEL ? 'none' : 'lax' // Required for cross-origin on Vercel
    },
    // Trust proxy on Vercel
    ...(IS_VERCEL && { proxy: true })
}));

// Trust proxy on Vercel
if (IS_VERCEL) {
    app.set('trust proxy', 1);
}

// Middleware to restore access token from cookie on Vercel
// This ensures authentication persists across serverless function invocations
app.use((req, res, next) => {
    if (!req.session.accessToken && req.cookies.access_token) {
        const decrypted = decryptToken(req.cookies.access_token);
        if (decrypted) {
            try {
                const tokenData = JSON.parse(decrypted);
                req.session.accessToken = tokenData;
                if (req.cookies.user_id) {
                    req.session.userId = req.cookies.user_id;
                }
                debugLog('AUTH', '✓ Access token restored from cookie');
            } catch (e) {
                debugLog('AUTH', '✗ Failed to parse access token from cookie');
            }
        }
    }
    next();
});

// Serve static files with aggressive caching for performance
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d',
    etag: true,
    lastModified: true,
    setHeaders: (res, filepath) => {
        if (filepath.endsWith('.js') || filepath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
        } else if (filepath.endsWith('.png') || filepath.endsWith('.jpg') || filepath.endsWith('.svg')) {
            res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
        }
    }
}));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Routes

// Feature detection endpoint - tells frontend what features are available
app.get('/api/features', (req, res) => {
    res.json({
        browserFeatures: BROWSER_FEATURES_ENABLED,
        quizViewer: BROWSER_FEATURES_ENABLED,
        isVercel: IS_VERCEL,
        message: IS_VERCEL
            ? 'Running on Vercel - some features like Quiz Viewer are unavailable'
            : 'All features available'
    });
});

app.get('/', (req, res) => {
    if (req.session.accessToken) {
        res.redirect('/dashboard');
    } else {
        res.render('index', { authenticated: false });
    }
});

// Start OAuth flow
app.get('/auth/schoology', async (req, res) => {
    debugLog('OAUTH-STEP1', '========== STEP 1: Starting OAuth Flow ==========');
    debugLog('OAUTH-STEP1', 'User initiated OAuth authentication');

    try {
        const requestTokenUrl = `${config.apiBase}/oauth/request_token`;
        debugLog('OAUTH-STEP1', `Requesting token from: ${requestTokenUrl}`);

        // Get request token
        const response = await makeOAuthRequest('GET', requestTokenUrl);
        debugLog('OAUTH-STEP1', 'Raw response from request_token:', response);

        // Parse the query-string-formatted result
        const params = new URLSearchParams(response);
        const oauth_token = params.get('oauth_token');
        const oauth_token_secret = params.get('oauth_token_secret');

        debugLog('OAUTH-STEP1', 'Parsed tokens:', {
            oauth_token: oauth_token ? oauth_token.substring(0, 12) + '...' : 'NULL',
            oauth_token_secret: oauth_token_secret ? oauth_token_secret.substring(0, 12) + '...' : 'NULL'
        });

        if (!oauth_token || !oauth_token_secret) {
            debugLog('OAUTH-STEP1', '✗ FAILED: Missing tokens in response');
            throw new Error('Failed to get request token from Schoology. Response: ' + response);
        }

        debugLog('OAUTH-STEP1', '✓ Successfully obtained request token');

        // Store request token in encrypted cookie (works on serverless/Vercel)
        const tokenData = JSON.stringify({ oauth_token, oauth_token_secret });
        const encryptedToken = encryptToken(tokenData);

        // Use 'lax' sameSite - we're on the same domain, just different routes
        res.cookie('oauth_request_token', encryptedToken, {
            httpOnly: true,
            secure: true, // Always use secure on Vercel (HTTPS)
            sameSite: 'lax', // 'lax' works for same-site navigation
            maxAge: 10 * 60 * 1000, // 10 minutes - just for OAuth flow
            path: '/' // Ensure cookie is available on all paths
        });

        // Also store in session as backup for local development
        req.session.requestToken = {
            oauth_token,
            oauth_token_secret
        };

        debugLog('OAUTH-STEP1', '✓ Request token stored in cookie and session');

        // Schoology doesn't like localhost callbacks - they get blocked by CloudFront
        // Instead, we'll show user the authorize page with the Schoology URL to open
        const authUrl = `https://${config.domain}/oauth/authorize?oauth_token=${encodeURIComponent(oauth_token)}`;

        debugLog('OAUTH-STEP2', '========== STEP 2: Showing Authorization Page ==========');
        debugLog('OAUTH-STEP2', `Authorization URL: ${authUrl}`);
        debugLog('OAUTH-STEP2', 'User will authorize on Schoology, then click complete');

        // Pass encrypted token via query param as backup for serverless environments
        // where cookies might not persist between function invocations
        const stateToken = encodeURIComponent(encryptedToken);

        // Render page that tells user to authorize
        res.render('authorize', { authUrl, stateToken });
    } catch (error) {
        debugLog('OAUTH-ERROR', '✗ OAuth Step 1/2 FAILED');
        debugLog('OAUTH-ERROR', `Error: ${error.message}`);
        debugLog('OAUTH-ERROR', 'Stack trace:', error.stack);
        res.render('error', { message: 'Failed to initiate OAuth. Please check your API credentials. Error: ' + error.message });
    }
});

// OAuth complete - user clicked "Complete Login" after authorizing on Schoology
app.get('/auth/complete', async (req, res) => {
    debugLog('OAUTH-STEP3', '========== STEP 3: Manual Auth Completion ==========');
    debugLog('OAUTH-STEP3', 'User clicked Complete Login after authorizing on Schoology');
    debugLog('OAUTH-STEP3', 'Available cookies:', Object.keys(req.cookies || {}));
    debugLog('OAUTH-STEP3', 'State param present:', !!req.query.state);

    try {
        // Try to get request token from multiple sources (in order of preference)
        let requestToken = null;

        // 1. First try the state query parameter (most reliable for serverless)
        if (req.query.state) {
            const decrypted = decryptToken(decodeURIComponent(req.query.state));
            if (decrypted) {
                requestToken = JSON.parse(decrypted);
                debugLog('OAUTH-STEP3', '✓ Request token retrieved from state parameter');
            }
        }

        // 2. Try cookie
        if (!requestToken) {
            const encryptedToken = req.cookies.oauth_request_token;
            debugLog('OAUTH-STEP3', 'Encrypted token from cookie:', encryptedToken ? 'present (' + encryptedToken.length + ' chars)' : 'NOT FOUND');

            if (encryptedToken) {
                const decrypted = decryptToken(encryptedToken);
                debugLog('OAUTH-STEP3', 'Decryption result:', decrypted ? 'success' : 'FAILED');
                if (decrypted) {
                    requestToken = JSON.parse(decrypted);
                    debugLog('OAUTH-STEP3', '✓ Request token retrieved from cookie');
                }
            }
        }

        // 3. Fall back to session (for local development)
        if (!requestToken) {
            requestToken = req.session.requestToken;
            debugLog('OAUTH-STEP3', 'Request token from session:', !!requestToken);
        }

        debugLog('OAUTH-STEP3', 'RequestToken exists:', !!requestToken);

        if (!requestToken) {
            debugLog('OAUTH-STEP3', '✗ FAILED: No request token in cookie or session');
            return res.render('error', { message: 'No request token found. Please try logging in again.' });
        }

        debugLog('OAUTH-STEP3', 'Using stored request token:', requestToken.oauth_token ? requestToken.oauth_token.substring(0, 12) + '...' : 'NULL');

        // Exchange request token for access token
        debugLog('OAUTH-STEP4', '========== STEP 4: Exchanging for Access Token ==========');
        const accessTokenUrl = `${config.apiBase}/oauth/access_token`;
        debugLog('OAUTH-STEP4', `Requesting access token from: ${accessTokenUrl}`);

        const response = await makeOAuthRequest('GET', accessTokenUrl, requestToken);
        debugLog('OAUTH-STEP4', 'Raw response from access_token:', response);

        // Parse access token
        const params = new URLSearchParams(response);
        const access_token = params.get('oauth_token');
        const access_token_secret = params.get('oauth_token_secret');

        debugLog('OAUTH-STEP4', 'Parsed access tokens:', {
            access_token: access_token ? access_token.substring(0, 12) + '...' : 'NULL',
            access_token_secret: access_token_secret ? access_token_secret.substring(0, 12) + '...' : 'NULL'
        });

        if (!access_token || !access_token_secret) {
            debugLog('OAUTH-STEP4', '✗ FAILED: Missing access tokens in response');
            debugLog('OAUTH-STEP4', 'This usually means the user has not authorized yet, or authorization expired');
            return res.render('error', {
                message: 'Could not get access token. Please make sure you clicked "Allow" on Schoology, then try again. If this keeps happening, start the login process over.'
            });
        }

        debugLog('OAUTH-STEP4', '✓ Successfully obtained access token');

        // Store access token in session
        req.session.accessToken = {
            oauth_token: access_token,
            oauth_token_secret: access_token_secret
        };

        // Also store in encrypted cookie for Vercel serverless persistence
        const accessTokenData = JSON.stringify({ oauth_token: access_token, oauth_token_secret: access_token_secret });
        res.cookie('access_token', encryptToken(accessTokenData), {
            httpOnly: true,
            secure: IS_VERCEL,
            sameSite: IS_VERCEL ? 'none' : 'lax',
            maxAge: 365 * 24 * 60 * 60 * 1000 // 1 year
        });

        debugLog('OAUTH-STEP4', '✓ Access token stored in session and cookie');

        // Clear request token and awaiting flag
        delete req.session.requestToken;
        delete req.session.awaitingAuth;
        delete req.session.authUrl;
        res.clearCookie('oauth_request_token'); // Clear the OAuth cookie
        debugLog('OAUTH-STEP4', '✓ Request token cleared from session and cookie');

        debugLog('OAUTH-COMPLETE', '========== OAuth Flow Complete! ==========');
        debugLog('OAUTH-COMPLETE', '✓ User is now authenticated');
        res.redirect('/dashboard');
    } catch (error) {
        debugLog('OAUTH-ERROR', '✗ OAuth Step 3/4 FAILED');
        debugLog('OAUTH-ERROR', `Error: ${error.message}`);
        debugLog('OAUTH-ERROR', 'Stack trace:', error.stack);
        res.render('error', { message: 'Failed to complete OAuth authorization. Make sure you clicked "Allow" on Schoology. Error: ' + error.message });
    }
});

// OAuth callback (legacy - in case Schoology does redirect back)
app.get('/auth/callback', async (req, res) => {
    debugLog('OAUTH-STEP3', '========== STEP 3: OAuth Callback Received ==========');
    debugLog('OAUTH-STEP3', 'Query parameters:', req.query);

    try {
        const { oauth_token } = req.query;
        const requestToken = req.session.requestToken;

        debugLog('OAUTH-STEP3', 'Received oauth_token:', oauth_token ? oauth_token.substring(0, 12) + '...' : 'NULL');
        debugLog('OAUTH-STEP3', 'Session requestToken exists:', !!requestToken);

        if (!requestToken) {
            debugLog('OAUTH-STEP3', '✗ FAILED: No request token in session');
            return res.render('error', { message: 'No request token found. Please try logging in again.' });
        }

        debugLog('OAUTH-STEP3', 'Stored request token:', requestToken.oauth_token ? requestToken.oauth_token.substring(0, 12) + '...' : 'NULL');

        // If oauth_token provided, verify it matches
        if (oauth_token && requestToken.oauth_token !== oauth_token) {
            debugLog('OAUTH-STEP3', '✗ FAILED: Token mismatch');
            debugLog('OAUTH-STEP3', `Expected: ${requestToken.oauth_token}`);
            debugLog('OAUTH-STEP3', `Received: ${oauth_token}`);
            return res.render('error', { message: 'Invalid OAuth token received.' });
        }

        debugLog('OAUTH-STEP3', '✓ Token validation passed');

        // Exchange request token for access token
        debugLog('OAUTH-STEP4', '========== STEP 4: Exchanging for Access Token ==========');
        const accessTokenUrl = `${config.apiBase}/oauth/access_token`;
        debugLog('OAUTH-STEP4', `Requesting access token from: ${accessTokenUrl}`);

        const response = await makeOAuthRequest('GET', accessTokenUrl, requestToken);
        debugLog('OAUTH-STEP4', 'Raw response from access_token:', response);

        // Parse access token
        const params = new URLSearchParams(response);
        const access_token = params.get('oauth_token');
        const access_token_secret = params.get('oauth_token_secret');

        debugLog('OAUTH-STEP4', 'Parsed access tokens:', {
            access_token: access_token ? access_token.substring(0, 12) + '...' : 'NULL',
            access_token_secret: access_token_secret ? access_token_secret.substring(0, 12) + '...' : 'NULL'
        });

        if (!access_token || !access_token_secret) {
            debugLog('OAUTH-STEP4', '✗ FAILED: Missing access tokens in response');
            throw new Error('Failed to get access token from Schoology. Response: ' + response);
        }

        debugLog('OAUTH-STEP4', '✓ Successfully obtained access token');

        // Store access token in session
        req.session.accessToken = {
            oauth_token: access_token,
            oauth_token_secret: access_token_secret
        };
        debugLog('OAUTH-STEP4', '✓ Access token stored in session');

        // Clear request token
        delete req.session.requestToken;
        debugLog('OAUTH-STEP4', '✓ Request token cleared from session');

        debugLog('OAUTH-COMPLETE', '========== OAuth Flow Complete! ==========');
        debugLog('OAUTH-COMPLETE', '✓ User is now authenticated');
        res.redirect('/dashboard');
    } catch (error) {
        debugLog('OAUTH-ERROR', '✗ OAuth Step 3/4 FAILED');
        debugLog('OAUTH-ERROR', `Error: ${error.message}`);
        debugLog('OAUTH-ERROR', 'Stack trace:', error.stack);
        res.render('error', { message: 'Failed to complete OAuth authorization. Error: ' + error.message });
    }
});

// Dashboard
app.get('/dashboard', async (req, res) => {
    debugLog('DASHBOARD', 'Dashboard requested');

    if (!req.session.accessToken) {
        debugLog('DASHBOARD', 'No access token, redirecting to home');
        return res.redirect('/');
    }

    debugLog('DASHBOARD', 'Access token found, fetching user info');

    try {
        // Step 1: Get user ID from app-user-info endpoint
        const appUserInfoUrl = `${config.apiBase}/app-user-info`;
        debugLog('DASHBOARD', `Fetching app-user-info from: ${appUserInfoUrl}`);

        const appUserInfo = await makeOAuthRequest('GET', appUserInfoUrl, req.session.accessToken, null, {
            cache: true,
            cacheKey: getCacheKey(req.session.userId || 'temp', 'app-user-info'),
            cacheTTL: CACHE_TTL.user
        });
        debugLog('DASHBOARD', '✓ app-user-info response:', appUserInfo);

        const userId = appUserInfo.api_uid;
        if (!userId) {
            throw new Error('No user ID returned from app-user-info. Response: ' + JSON.stringify(appUserInfo));
        }

        debugLog('DASHBOARD', `✓ Got user ID: ${userId}`);

        // Step 2: Get full user details using the user ID
        const userUrl = `${config.apiBase}/users/${userId}`;
        debugLog('DASHBOARD', `Fetching full user details from: ${userUrl}`);

        const user = await makeOAuthRequest('GET', userUrl, req.session.accessToken, null, {
            cache: true,
            cacheKey: getCacheKey(userId, 'user-details'),
            cacheTTL: CACHE_TTL.user
        });
        debugLog('DASHBOARD', '✓ User data received:', {
            id: user.id,
            name: `${user.name_first} ${user.name_last}`,
            email: user.primary_email
        });

        req.session.userId = user.id;
        req.session.userName = `${user.name_first} ${user.name_last}`;

        // Store user ID in cookie for Vercel serverless persistence
        res.cookie('user_id', user.id, {
            httpOnly: true,
            secure: IS_VERCEL,
            sameSite: IS_VERCEL ? 'none' : 'lax',
            maxAge: 365 * 24 * 60 * 60 * 1000 // 1 year
        });

        // Step 3: PARALLEL FETCH - Get sections and grades simultaneously
        debugLog('DASHBOARD', '⚡ Starting parallel fetch for sections and grades...');
        const startTime = Date.now();

        let sections = [];
        let allGradesData = null;

        try {
            // Use Promise.all to fetch sections and grades in parallel
            const [sectionsResult, gradesResult] = await Promise.all([
                // Fetch sections (with caching)
                fetchAllSectionsOptimized(user.id, req.session.accessToken).catch(e => {
                    debugLog('DASHBOARD', `Could not fetch sections: ${e.message}`);
                    return [];
                }),
                // Fetch grades (with caching)
                fetchAllGradesOptimized(user.id, req.session.accessToken).catch(e => {
                    debugLog('DASHBOARD', `Could not fetch grades: ${e.message}`);
                    return null;
                })
            ]);

            sections = sectionsResult.slice(0, 20); // Limit to 20 for dashboard
            allGradesData = gradesResult;

            debugLog('DASHBOARD', `⚡ Parallel fetch completed in ${Date.now() - startTime}ms`);
            debugLog('DASHBOARD', `✓ Found ${sections.length} sections`);

            // Parse and attach final grades to sections
            if (allGradesData) {
                const { sectionGrades } = parseGradesIntoMap(allGradesData);

                // Also check periods for final grade
                if (allGradesData.section) {
                    for (const sec of allGradesData.section) {
                        if (sectionGrades[sec.section_id] === null) {
                            const periods = sec.period || [];
                            for (const period of periods) {
                                if (period.period_id === 'final' || period.period_title === 'Final Grade' || period.period_title === 'Overall') {
                                    const assignments = period.assignment || [];
                                    if (assignments.length > 0 && assignments[0].grade !== null && assignments[0].grade !== undefined && assignments[0].grade !== '') {
                                        const parsed = parseFloat(assignments[0].grade);
                                        if (!isNaN(parsed)) sectionGrades[sec.section_id] = parsed;
                                    }
                                }
                            }
                        }
                    }
                }

                // Attach grades to sections
                sections = sections.map(s => ({
                    ...s,
                    final_grade: sectionGrades[s.id] !== undefined ? sectionGrades[s.id] : null
                }));

                debugLog('DASHBOARD', `✓ Attached grades to ${Object.keys(sectionGrades).length} sections`);
            }
        } catch (e) {
            debugLog('DASHBOARD', `Error in parallel fetch: ${e.message}`);
        }

        // Load schedule to check for current class
        const schedule = loadSchedule(user.id);
        let currentClass = null;

        // Check if there's a class currently happening
        const now = new Date();
        const dayOfWeek = now.getDay(); // 0=Sunday, 1=Monday, etc

        // Only check Mon-Fri (1-5)
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
            const dayBlocks = schedule[dayOfWeek] || [];
            const currentMinutes = now.getHours() * 60 + now.getMinutes();

            for (const block of dayBlocks) {
                const blockStart = block.startHour * 60 + block.startMinute;
                const blockEnd = blockStart + block.duration;

                if (currentMinutes >= blockStart && currentMinutes < blockEnd) {
                    // Found the current class
                    currentClass = {
                        sectionId: block.sectionId,
                        courseName: block.courseName,
                        endTime: blockEnd,
                        startTime: blockStart
                    };
                    break;
                }
            }
        }

        debugLog('DASHBOARD', '✓ Rendering dashboard');
        res.render('dashboard', {
            user,
            sections,
            currentClass,
            authenticated: true
        });
    } catch (error) {
        debugLog('DASHBOARD', `✗ Error fetching user: ${error.message}`);
        debugLog('DASHBOARD', 'Showing error with token info for debugging');

        // Show error with token details for debugging instead of redirecting
        const tokenInfo = req.session.accessToken ? {
            oauth_token: req.session.accessToken.oauth_token,
            oauth_token_secret: req.session.accessToken.oauth_token_secret
        } : null;

        res.render('error', {
            message: `Failed to fetch user data: ${error.message}`,
            debugInfo: {
                error: error.message,
                stack: error.stack,
                accessToken: tokenInfo ? tokenInfo.oauth_token : 'No token',
                accessTokenSecret: tokenInfo ? tokenInfo.oauth_token_secret : 'No secret',
                apiBase: config.apiBase,
                domain: config.domain
            }
        });
    }
});

// Helper function to fetch all pages of assignments with caching
async function fetchAllAssignments(sectionId, accessToken, userId = null) {
    // Use cache if userId provided
    if (userId) {
        const cacheKey = getCacheKey(userId, `assignments-${sectionId}`);
        const cached = getCachedData(cacheKey, CACHE_TTL.assignments);
        if (cached) {
            // Normalize cached shapes: either array or raw API response
            if (Array.isArray(cached)) return cached;
            if (cached && typeof cached === 'object' && Array.isArray(cached.assignment)) return cached.assignment;
        }
    }

    // Use higher limit for fewer API calls
    const url = `${config.apiBase}/sections/${sectionId}/assignments?limit=200`;
    debugLog('FETCH', `  Fetching assignments: ${url}`);
    
    const data = await makeOAuthRequest('GET', url, accessToken, null, {
        cache: !!userId,
        cacheKey: userId ? getCacheKey(userId, `assignments-${sectionId}`) : null,
        cacheTTL: CACHE_TTL.assignments
    });
    
    const assignments = data && Array.isArray(data.assignment) ? data.assignment : [];
    // Cache the processed assignments array for consistent reads
    if (userId) {
        try { setCachedData(getCacheKey(userId, `assignments-${sectionId}`), assignments); } catch (e) { debugLog('CACHE', `Could not set assignments cache: ${e.message}`); }
    }
    debugLog('FETCH', `  ✓ Found ${assignments.length} assignments`);
    
    return assignments;
}

// Assignments page
app.get('/assignments', async (req, res) => {
    debugLog('ASSIGNMENTS', 'Assignments page requested');

    if (!req.session.accessToken) {
        debugLog('ASSIGNMENTS', 'No access token, redirecting to home');
        return res.redirect('/');
    }

    try {
        const startTime = Date.now();

        // ⚡ PARALLEL FETCH: Get sections and grades simultaneously with caching
        debugLog('ASSIGNMENTS', '⚡ Starting parallel fetch for sections and grades...');

        const [sections, gradesData] = await Promise.all([
            fetchAllSectionsOptimized(req.session.userId, req.session.accessToken),
            fetchAllGradesOptimized(req.session.userId, req.session.accessToken).catch(e => {
                debugLog('ASSIGNMENTS', `Could not fetch grades: ${e.message}`);
                return null;
            })
        ]);

        debugLog('ASSIGNMENTS', `✓ Found ${sections.length} sections`);

        // Parse grades into lookup map
        const { gradesMap: allGrades } = gradesData ? parseGradesIntoMap(gradesData) : { gradesMap: {} };
        debugLog('ASSIGNMENTS', `✓ Fetched grades for ${Object.keys(allGrades).length} assignments`);

        // ⚡ PARALLEL FETCH: Get assignments for all sections in parallel (up to 10)
        const sectionsToFetch = sections.slice(0, 10);
        debugLog('ASSIGNMENTS', `⚡ Fetching assignments for ${sectionsToFetch.length} sections in parallel...`);

        const assignmentsResults = await fetchAssignmentsForSectionsParallel(
            sectionsToFetch.map(s => s.id),
            req.session.accessToken,
            5 // Max 5 concurrent requests
        );

        // Combine all assignments
        let allAssignments = [];
        for (const section of sectionsToFetch) {
            const result = assignmentsResults[section.id];
            if (result && result.assignments) {
                result.assignments.forEach(assignment => {
                    assignment.course_name = section.course_title || section.section_title;
                    assignment.section_id = section.id;

                    // Attach grade info if available
                    const gradeInfo = allGrades[assignment.id];
                    if (gradeInfo) {
                        assignment.grade = gradeInfo.grade;
                        assignment.exception = gradeInfo.exception;
                        assignment.pending = gradeInfo.pending;
                    }
                });
                allAssignments = allAssignments.concat(result.assignments);
            }
            if (result && result.error) {
                debugLog('ASSIGNMENTS', `  ✗ Error for section ${section.id}: ${result.error}`);
            }
        }

        debugLog('ASSIGNMENTS', `⚡ All assignments fetched in ${Date.now() - startTime}ms`);

        // Get current time for comparison
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // Helper to check if assignment has a valid due date
        const hasDueDate = (a) => a.due && a.due.trim() !== '';

        // Helper to get effective date for assignment (due date, or last_updated if no due)
        const getEffectiveDate = (a) => {
            if (hasDueDate(a)) {
                return new Date(a.due);
            }
            if (a.last_updated) {
                return new Date(a.last_updated * 1000);
            }
            return new Date(0);
        };

        // Helper to check if a submission exists for an assignment or quiz
        const checkSubmissionExists = async (sectionId, assignmentId, assignment) => {
            try {
                const isQuiz = assignment.type === 'assessment' || assignment.type === 'assessment_v2';

                if (isQuiz) {
                    const gradeInfo = allGrades[assignmentId];
                    if (gradeInfo) {
                        const hasCompletedAttempt = gradeInfo.grade !== null && gradeInfo.grade !== undefined && gradeInfo.grade !== '';
                        const hasPendingSubmission = gradeInfo.pending !== null && gradeInfo.pending !== undefined && gradeInfo.pending !== '';
                        if (hasCompletedAttempt || hasPendingSubmission) {
                            return true;
                        }
                    }
                    return false;
                }

                // For regular assignments, check the submissions endpoint
                const submissionUrl = `${config.apiBase}/sections/${sectionId}/submissions/${assignmentId}/${req.session.userId}`;
                const submissionData = await makeOAuthRequest('GET', submissionUrl, req.session.accessToken);
                if (submissionData && submissionData.revision) {
                    const revisions = Array.isArray(submissionData.revision) ? submissionData.revision : [submissionData.revision];
                    if (revisions.length > 0) {
                        return true;
                    }
                }

                // Check for LTI submission
                const assignmentUrl = `${config.apiBase}/sections/${sectionId}/assignments/${assignmentId}`;
                const fullAssignment = await makeOAuthRequest('GET', assignmentUrl, req.session.accessToken);

                if (fullAssignment && fullAssignment.assignment_type === 'lti_submission' && fullAssignment.completed == 1) {
                    return true;
                }

                return false;
            } catch (e) {
                return false;
            }
        };

        // Separate upcoming and overdue assignments
        const upcomingAssignments = [];
        const overdueAssignments = [];
        const overdueCandidates = [];

        allAssignments.forEach(a => {
            const gradeVal = a.grade;
            const hasGrade = gradeVal !== null && gradeVal !== undefined && gradeVal !== '';
            const hasDue = hasDueDate(a);
            const isPastDue = hasDue && new Date(a.due) < todayStart;
            const isSubmittable = a.allow_dropbox == 1 || a.allow_dropbox === '1';
            const exceptionVal = parseInt(a.exception) || 0;
            const isExcused = exceptionVal === 1;
            const isMissing = exceptionVal === 2;
            const isQuiz = a.type === 'assessment' || a.type === 'assessment_v2';
            // dropbox_locked means a submission was collected (late submission accepted)
            const isDropboxLocked = a.dropbox_locked == 1 || a.dropbox_locked === '1';
            // pending indicates there's a submission waiting for grading
            const hasPendingSubmission = a.pending !== null && a.pending !== undefined && a.pending !== '';

            // Never overdue if: excused, has a grade, submission collected, or has pending submission
            if (isExcused) {
                if (hasDue && !isPastDue) {
                    upcomingAssignments.push(a);
                }
                return;
            }
            if (hasGrade) {
                return;
            }
            if (isDropboxLocked) {
                return;
            }
            if (hasPendingSubmission) {
                // Has submission waiting for grading - not overdue
                return;
            }

            // Candidate for overdue:
            // 1. Must be past due
            // 2. Not excused, graded, or collected (checked above)
            // 3. Either: marked missing OR submittable OR quiz
            const isPotentiallyOverdue = isPastDue && (
                isMissing || isSubmittable || isQuiz
            );

            if (isPotentiallyOverdue) {
                // If submittable or quiz, we need to check if there's actually a submission/attempt
                if (isSubmittable || isQuiz) {
                    overdueCandidates.push(a);
                } else {
                    // Non-submittable and non-quiz but marked missing - definitely overdue
                    overdueAssignments.push(a);
                }
            } else if (hasDue && !isPastDue) {
                // Upcoming: HAS a due date (required), NOT past due
                upcomingAssignments.push(a);
            }
        });

        // Check submissions for overdue candidates (in parallel, batched)
        debugLog('ASSIGNMENTS', `Checking submissions for ${overdueCandidates.length} overdue candidates...`);
        const submissionChecks = await Promise.all(
            overdueCandidates.map(async (a) => {
                const hasSubmission = await checkSubmissionExists(a.section_id, a.id, a);
                debugLog('ASSIGNMENTS', `  "${a.title}" - hasSubmission=${hasSubmission}, type=${a.assignment_type || 'standard'}, completed=${a.completed}`);
                return { assignment: a, hasSubmission };
            })
        );

        // Add to overdue only if no submission exists
        for (const { assignment, hasSubmission } of submissionChecks) {
            if (!hasSubmission) {
                overdueAssignments.push(assignment);
            }
        }

        // Apply adjusted due times from schedule
        // Load schedule from disk first to ensure we have the latest
        loadSchedule(req.session.userId);
        const userSchedule = scheduleCache[req.session.userId] || {};
        const adjustedDueTimes = userSchedule.adjustedDueTimes || {};

        const applyAdjustedDueTime = (assignment) => {
            const adjusted = adjustedDueTimes[assignment.id];
            if (adjusted) {
                assignment.originalDue = assignment.due;
                assignment.due = adjusted.adjustedDue;
                assignment.dueAdjusted = true;
            }
            return assignment;
        };

        // Apply to all assignments
        upcomingAssignments.forEach(applyAdjustedDueTime);
        overdueAssignments.forEach(applyAdjustedDueTime);

        // Sort upcoming by effective date (soonest first)
        // Assignments without due dates use last_updated and are mixed in with others
        upcomingAssignments.sort((a, b) => {
            return getEffectiveDate(a) - getEffectiveDate(b);
        });

        // Sort overdue by how overdue they are (most overdue first = oldest due date first)
        overdueAssignments.sort((a, b) => {
            return new Date(a.due) - new Date(b.due);
        });

        // Add time estimates to all assignments
        const upcomingWithTime = addTimeEstimates(upcomingAssignments);
        const overdueWithTime = addTimeEstimates(overdueAssignments);

        debugLog('ASSIGNMENTS', `✓ Total: ${allAssignments.length}, Upcoming: ${upcomingAssignments.length}, Overdue: ${overdueAssignments.length}`);
        debugLog('ASSIGNMENTS', '✓ Rendering assignments page');

        res.render('assignments', {
            upcomingAssignments: upcomingWithTime,
            overdueAssignments: overdueWithTime,
            sections,
            authenticated: true,
            userName: req.session.userName
        });
    } catch (error) {
        debugLog('ASSIGNMENTS', `✗ Error fetching assignments: ${error.message}`);
        res.render('error', { message: 'Failed to fetch assignments: ' + error.message });
    }
});

// Grades page
app.get('/grades', async (req, res) => {
    debugLog('GRADES', 'Grades page requested');

    if (!req.session.accessToken) {
        debugLog('GRADES', 'No access token, redirecting to home');
        return res.redirect('/');
    }

    try {
        const startTime = Date.now();

        // ⚡ PARALLEL FETCH: Get sections and grades simultaneously with caching
        debugLog('GRADES', '⚡ Starting parallel fetch for sections and grades...');

        const [allSections, allGradesData] = await Promise.all([
            fetchAllSectionsOptimized(req.session.userId, req.session.accessToken),
            fetchAllGradesOptimized(req.session.userId, req.session.accessToken).catch(e => {
                debugLog('GRADES', `! Could not fetch all grades: ${e.message}`);
                return null;
            })
        ]);

        debugLog('GRADES', `⚡ Sections and grades fetched in ${Date.now() - startTime}ms`);
        debugLog('GRADES', `✓ Found ${allSections.length} total sections`);

        // Parse final grades from the all-grades response
        const { sectionGrades: sectionFinalGrades, sectionGradeData, gradesMap: globalGradesMap } = allGradesData
            ? parseGradesIntoMap(allGradesData)
            : { sectionGrades: {}, sectionGradeData: {}, gradesMap: {} };

        debugLog('GRADES', `✓ Parsed final grades for ${Object.keys(sectionFinalGrades).length} sections`);

        // ⚡ PARALLEL FETCH: Get assignments and categories for all sections
        debugLog('GRADES', '⚡ Fetching assignments and categories in parallel...');
        const parallelStartTime = Date.now();

        const sectionIds = allSections.map(s => s.id);

        const [assignmentsResults, categoriesResults] = await Promise.all([
            fetchAssignmentsForSectionsParallel(sectionIds, req.session.accessToken, 5, req.session.userId),
            fetchCategoriesForSectionsParallel(sectionIds, req.session.accessToken, 5, req.session.userId)
        ]);

        debugLog('GRADES', `⚡ Assignments and categories fetched in ${Date.now() - parallelStartTime}ms`);

        // Process grades for each section
        let gradesData = [];

        for (const section of allSections) {
            try {
                debugLog('GRADES', `Processing section ${section.id}: ${section.course_title || section.section_title}`);

                // Get the final grade from our pre-fetched data
                let finalGrade = sectionFinalGrades[section.id];
                if (finalGrade === undefined || finalGrade === null || isNaN(finalGrade)) {
                    finalGrade = null;
                }

                debugLog('GRADES', `  Final grade: ${finalGrade !== null ? finalGrade : 'N/A'}`);

                // Use pre-fetched grade data
                const sectionGradesData = sectionGradeData[section.id]
                    ? { section: [sectionGradeData[section.id]] }
                    : { section: [] };

                debugLog('GRADES', `  Has section grade data from user/grades: ${!!sectionGradeData[section.id]}`);

                // Get pre-fetched assignments
                const assignmentResult = assignmentsResults[section.id];
                const assignments = assignmentResult ? assignmentResult.assignments : [];

                debugLog('GRADES', `  Assignments found: ${assignments.length}`);

                // Create assignment lookup
                const assignmentLookup = {};
                assignments.forEach(a => {
                    assignmentLookup[a.id] = a;
                });

                // Get pre-fetched categories
                const categoryResult = categoriesResults[section.id];
                const categories = categoryResult ? categoryResult.categories : [];

                // Parse grades from API
                let gradesList = [];
                const sectionArray = sectionGradesData.section || [];

                for (const sec of sectionArray) {
                    // Use == for loose comparison to handle string vs number IDs
                    if (sec.section_id == section.id || sectionArray.length === 1) {
                        const periods = sec.period || [];
                        for (const period of periods) {
                            const periodAssignments = period.assignment || [];
                            gradesList = gradesList.concat(periodAssignments);
                        }
                    }
                }

                // If no grades found from user-level API and we have assignments, 
                // try fetching section-specific grades
                if (gradesList.length === 0 && assignments.length > 0 && !sectionGradeData[section.id]) {
                    debugLog('GRADES', `  No user-level grades, trying section-specific grades...`);
                    const sectionSpecificGrades = await fetchSectionGrades(section.id, req.session.accessToken);

                    if (sectionSpecificGrades) {
                        // Handle both wrapped {section: [...]} and unwrapped response formats
                        let sections = [];
                        if (sectionSpecificGrades.section) {
                            sections = Array.isArray(sectionSpecificGrades.section)
                                ? sectionSpecificGrades.section
                                : [sectionSpecificGrades.section];
                        } else if (sectionSpecificGrades.period) {
                            // Handle case where response IS the section object directly
                            sections = [sectionSpecificGrades];
                        }

                        for (const sec of sections) {
                            // Try to extract final grade if we don't have it yet
                            if (finalGrade === null) {
                                if (sec.final_grade !== undefined && sec.final_grade !== null && sec.final_grade !== '') {
                                    if (Array.isArray(sec.final_grade) && sec.final_grade.length > 0) {
                                        const fg = sec.final_grade[0];
                                        if (fg.grade !== undefined) {
                                            const parsed = parseFloat(fg.grade);
                                            if (!isNaN(parsed)) finalGrade = parsed;
                                        }
                                    } else {
                                        const parsed = parseFloat(sec.final_grade);
                                        if (!isNaN(parsed)) finalGrade = parsed;
                                    }
                                }
                            }

                            const periods = sec.period || [];
                            for (const period of periods) {
                                const periodAssignments = period.assignment || [];
                                gradesList = gradesList.concat(periodAssignments);
                            }
                        }
                        debugLog('GRADES', `  Found ${gradesList.length} grades from section-specific API`);
                    }
                }

                // Create a map of assignment ID -> grade data for quick lookup
                // Use String() for keys to ensure type matching (API might return numbers, assignments might have strings)
                const gradesMap = {};
                gradesList.forEach(g => {
                    gradesMap[String(g.assignment_id)] = g;
                });

                debugLog('GRADES', `  Grades found: ${gradesList.length}`);
                debugLog('GRADES', `  Grades mapped: ${Object.keys(gradesMap).length}`);

                let grades = [];
                let totalPoints = 0;
                let earnedPoints = 0;

                // Process all assignments, merging with grade data when available
                if (assignments.length > 0) {
                    for (const assignment of assignments) {
                        // Use String() for lookup to match map keys
                        // Try local map first, then global map (handles linked sections)
                        const grade = gradesMap[String(assignment.id)] || globalGradesMap[String(assignment.id)];
                        const maxPoints = parseFloat((grade?.max_points) || assignment.max_points || 100);

                        if (grade) {
                            // If we found the grade via global map (linked section), try to recover final grade
                            if (finalGrade === null && grade._section_id && grade._section_id != section.id) {
                                const linkedFinalGrade = sectionFinalGrades[grade._section_id];
                                if (linkedFinalGrade !== undefined && linkedFinalGrade !== null) {
                                    finalGrade = linkedFinalGrade;
                                    debugLog('GRADES', `  Recovered final grade ${finalGrade} from linked section ${grade._section_id}`);
                                }
                            }

                            // Assignment has grade data from API
                            if (grade.grade !== null && grade.grade !== undefined && grade.grade !== '' && grade.exception === 0) {
                                earnedPoints += parseFloat(grade.grade);
                                totalPoints += maxPoints;
                            }

                            grades.push({
                                ...grade,
                                title: assignment.title || 'Unknown Assignment',
                                max_points: maxPoints,
                                category: assignment.grading_category || 0,
                                due: assignment.due
                            });
                        } else {
                            // Assignment exists but no grade data - show without grade
                            grades.push({
                                assignment_id: assignment.id,
                                grade: null,
                                exception: 0,
                                title: assignment.title || 'Unknown Assignment',
                                max_points: maxPoints,
                                category: assignment.grading_category || 0,
                                due: assignment.due
                            });
                        }
                    }
                } else if (gradesList.length > 0) {
                    // Edge case: grades exist but no assignments found (shouldn't happen often)
                    for (const grade of gradesList) {
                        const assignment = assignmentLookup[grade.assignment_id] || {};
                        const maxPoints = parseFloat(grade.max_points || assignment.max_points || 100);

                        if (grade.grade !== null && grade.grade !== undefined && grade.grade !== '' && grade.exception === 0) {
                            earnedPoints += parseFloat(grade.grade);
                            totalPoints += maxPoints;
                        }

                        grades.push({
                            ...grade,
                            title: assignment.title || 'Unknown Assignment',
                            max_points: maxPoints,
                            category: assignment.grading_category || 0,
                            due: assignment.due
                        });
                    }
                }

                let percentage = finalGrade;

                // Group grades by category
                const categoryLookup = {};
                categories.forEach(cat => {
                    categoryLookup[cat.id] = {
                        ...cat,
                        grades: []
                    };
                });
                categoryLookup[0] = { id: 0, title: 'Uncategorized', weight: null, grades: [] };

                grades.forEach(grade => {
                    const catId = grade.category || 0;
                    if (categoryLookup[catId]) {
                        categoryLookup[catId].grades.push(grade);
                    } else {
                        categoryLookup[0].grades.push(grade);
                    }
                });

                const categoriesWithGrades = Object.values(categoryLookup).filter(cat => cat.grades.length > 0);

                gradesData.push({
                    section_id: section.id,
                    course_name: section.course_title || section.section_title,
                    grades,
                    categories: categoriesWithGrades,
                    totalPoints,
                    earnedPoints,
                    percentage
                });
            } catch (e) {
                debugLog('GRADES', `  ✗ Error for section ${section.id}: ${e.message}`);
                gradesData.push({
                    section_id: section.id,
                    course_name: section.course_title || section.section_title,
                    grades: [],
                    categories: [],
                    totalPoints: 0,
                    earnedPoints: 0,
                    percentage: null,
                    error: e.message
                });
            }
        }

        // Sort courses: those with grades first, N/A at bottom
        const sortedGradesData = gradesData.sort((a, b) => {
            if ((a.percentage !== null) === (b.percentage !== null)) {
                return (a.course_name || '').localeCompare(b.course_name || '');
            }
            return a.percentage !== null ? -1 : 1;
        });

        debugLog('GRADES', `⚡ Total processing time: ${Date.now() - startTime}ms`);
        debugLog('GRADES', `✓ Total courses processed: ${gradesData.length}`);
        debugLog('GRADES', '✓ Rendering grades page');

        res.render('grades', {
            gradesData: sortedGradesData,
            authenticated: true,
            userName: req.session.userName
        });
    } catch (error) {
        debugLog('GRADES', `✗ Error fetching grades: ${error.message}`);
        res.render('error', { message: 'Failed to fetch grades: ' + error.message });
    }
});

// Helper function to recursively fetch folder contents
async function fetchFolderContents(sectionId, folderId, accessToken, depth = 0, userId = null, skipRecursion = true) {
    if (depth > 5) return []; // Max depth to prevent infinite loops

    // Use cache if userId provided
    if (userId) {
        const cacheKey = getCacheKey(userId, `folder-${sectionId}-${folderId}`);
        const cached = getCachedData(cacheKey, CACHE_TTL.courses);
        if (cached) {
            if (Array.isArray(cached)) return cached;
            if (cached && typeof cached === 'object' && Array.isArray(cached['folder-item'])) {
                return cached['folder-item'].map(item => ({
                    id: item.id,
                    title: item.title || 'Untitled',
                    type: item.type || 'unknown',
                    body: item.body || '',
                    location: item.location || '',
                    available: item.available,
                    status: item.status,
                    due: item.due || null,
                    children: []
                }));
            }
        }
    }

    try {
        const url = `${config.apiBase}/courses/${sectionId}/folder/${folderId}`;
        debugLog('COURSES', `  ${'  '.repeat(depth)}Fetching folder ${folderId}: ${url}`);
        const data = await makeOAuthRequest('GET', url, accessToken, null, {
            cache: !!userId,
            cacheKey: userId ? getCacheKey(userId, `folder-${sectionId}-${folderId}`) : null,
            cacheTTL: CACHE_TTL.courses
        });

        const items = [];
        // API returns 'folder-item' array, not 'content'
        const contents = data['folder-item'] || [];
        debugLog('COURSES', `  ${'  '.repeat(depth)}Found ${contents.length} items in folder ${folderId}`);

        for (const item of contents) {
            const folderItem = {
                id: item.id,
                title: item.title || 'Untitled',
                type: item.type || 'unknown',
                body: item.body || '',
                location: item.location || '',
                available: item.available,
                status: item.status,
                due: item.due || null,
                children: []
            };

            // Skip recursive folder fetching for speed (can be fetched on-demand in UI)
            if (item.type === 'folder' && !skipRecursion) {
                folderItem.children = await fetchFolderContents(sectionId, item.id, accessToken, depth + 1, userId, skipRecursion);
            }

            items.push(folderItem);
        }

        return items;
    } catch (e) {
        debugLog('COURSES', `  ${'  '.repeat(depth)}✗ Error fetching folder ${folderId}: ${e.message}`);
        return [];
    }
}

// Courses page - shows course materials in folder structure
app.get('/courses', async (req, res) => {
    debugLog('COURSES', 'Courses page requested');

    if (!req.session.accessToken) {
        debugLog('COURSES', 'No access token, redirecting to home');
        return res.redirect('/');
    }

    try {
        const startTime = Date.now();

        // ⚡ Use cached sections
        debugLog('COURSES', '⚡ Fetching sections with caching...');
        const allSections = await fetchAllSectionsOptimized(req.session.userId, req.session.accessToken);
        debugLog('COURSES', `✓ Found ${allSections.length} total sections`);

        // Get selected section from query param, default to first section
        const selectedSectionId = req.query.section || (allSections.length > 0 ? allSections[0].id : null);
        const selectedSection = allSections.find(s => String(s.id) === String(selectedSectionId)) || allSections[0];

        let folderContents = [];
        let upcomingAssignments = [];
        let overdueAssignments = [];

        if (selectedSection) {
            debugLog('COURSES', `Selected section: ${selectedSection.course_title || selectedSection.section_title} (${selectedSection.id})`);

            // ⚡ PARALLEL FETCH: Get folder contents, assignments, and grades simultaneously
            debugLog('COURSES', '⚡ Starting parallel fetch for folder contents, assignments, and grades...');

            const [folderResult, assignmentsResult, gradesResult] = await Promise.all([
                // Fetch folder contents (recursion enabled to show folder structure)
                fetchFolderContents(selectedSection.id, 0, req.session.accessToken, 0, req.session.userId, false).catch(e => {
                    debugLog('COURSES', `Could not fetch folder contents: ${e.message}`);
                    return [];
                }),
                // Fetch assignments with caching
                fetchAllAssignments(selectedSection.id, req.session.accessToken, req.session.userId).catch(e => {
                    debugLog('COURSES', `Could not fetch assignments: ${e.message}`);
                    return [];
                }),
                // Fetch grades (from cached all grades if available)
                fetchAllGradesOptimized(req.session.userId, req.session.accessToken).catch(e => {
                    debugLog('COURSES', `Could not fetch grades: ${e.message}`);
                    return null;
                })
            ]);

            debugLog('COURSES', `⚡ Parallel fetch completed in ${Date.now() - startTime}ms`);

            folderContents = folderResult;
            debugLog('COURSES', `✓ Retrieved ${folderContents.length} top-level items`);

            const assignments = assignmentsResult;

            // Parse grades into map
            let gradesMap = {};
            if (gradesResult) {
                const { gradesMap: parsedMap } = parseGradesIntoMap(gradesResult);
                gradesMap = parsedMap;
            }

            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

            const hasDueDate = (a) => a.due && a.due.trim() !== '';

            for (const assignment of assignments) {
                const gradeInfo = gradesMap[assignment.id];
                const gradeVal = gradeInfo ? gradeInfo.grade : null;
                const hasGrade = gradeVal !== null && gradeVal !== undefined && gradeVal !== '';
                const hasDue = hasDueDate(assignment);
                const isPastDue = hasDue && new Date(assignment.due) < todayStart;
                const isSubmittable = assignment.allow_dropbox === 1 || assignment.allow_dropbox === '1';
                const exceptionVal = gradeInfo ? (parseInt(gradeInfo.exception) || 0) : 0;
                const isExcused = exceptionVal === 1;
                const isMissing = exceptionVal === 2;
                const isQuiz = assignment.type === 'assessment' || assignment.type === 'assessment_v2';
                const isDropboxLocked = assignment.dropbox_locked == 1 || assignment.dropbox_locked === '1';
                const hasPendingSubmission = gradeInfo && gradeInfo.pending !== null && gradeInfo.pending !== undefined && gradeInfo.pending !== '';

                if (isExcused || hasGrade || isDropboxLocked || hasPendingSubmission) {
                    if (hasDue && !isPastDue && !hasGrade && !isDropboxLocked) {
                        upcomingAssignments.push(assignment);
                    }
                    continue;
                }

                const isOverdueAssignment = isPastDue && (
                    isMissing || isSubmittable || isQuiz
                );

                if (isOverdueAssignment) {
                    overdueAssignments.push(assignment);
                } else if (hasDue && !isPastDue) {
                    upcomingAssignments.push(assignment);
                }
            }

            upcomingAssignments.sort((a, b) => new Date(a.due) - new Date(b.due));
            overdueAssignments.sort((a, b) => new Date(a.due) - new Date(b.due));

            debugLog('COURSES', `✓ Upcoming: ${upcomingAssignments.length}, Overdue: ${overdueAssignments.length}`);
        }

        debugLog('COURSES', `⚡ Total processing time: ${Date.now() - startTime}ms`);
        debugLog('COURSES', '✓ Rendering courses page');

        res.render('courses', {
            sections: allSections,
            selectedSection,
            folderContents,
            upcomingAssignments,
            overdueAssignments,
            authenticated: true,
            userName: req.session.userName
        });
    } catch (error) {
        debugLog('COURSES', `✗ Error fetching courses: ${error.message}`);
        res.render('error', { message: 'Failed to fetch courses: ' + error.message });
    }
});

// Assignment detail page
app.get('/assignment', async (req, res) => {
    debugLog('ASSIGNMENT', 'Assignment page requested');

    if (!req.session.accessToken) {
        debugLog('ASSIGNMENT', 'No access token, redirecting to home');
        return res.redirect('/');
    }

    const sectionId = req.query.section;
    const assignmentId = req.query.id;

    if (!sectionId || !assignmentId) {
        return res.render('error', { message: 'Missing section or assignment ID' });
    }

    try {
        // ⚡ PARALLEL FETCH: Get assignment, section, categories, and grade simultaneously
        debugLog('ASSIGNMENT', '⚡ Starting parallel fetch...');
        const startTime = Date.now();

        const assignmentUrl = `${config.apiBase}/sections/${sectionId}/assignments/${assignmentId}?with_attachments=1`;
        const sectionUrl = `${config.apiBase}/sections/${sectionId}`;
        const gradesUrl = `${config.apiBase}/sections/${sectionId}/grades?assignment_id=${assignmentId}`;

        const [assignment, section, gradesData] = await Promise.all([
            makeOAuthRequest('GET', assignmentUrl, req.session.accessToken, null, {
                cache: true,
                cacheKey: getCacheKey(req.session.userId, `assignment-${sectionId}-${assignmentId}`),
                cacheTTL: CACHE_TTL.assignments
            }),
            makeOAuthRequest('GET', sectionUrl, req.session.accessToken, null, {
                cache: true,
                cacheKey: getCacheKey(req.session.userId, `section-${sectionId}`),
                cacheTTL: CACHE_TTL.courses
            }),
            makeOAuthRequest('GET', gradesUrl, req.session.accessToken, null, {
                cache: true,
                cacheKey: getCacheKey(req.session.userId, `grade-${sectionId}-${assignmentId}`),
                cacheTTL: CACHE_TTL.grades
            }).catch(e => {
                debugLog('ASSIGNMENT', `Could not fetch grade: ${e.message}`);
                return null;
            })
        ]);

        debugLog('ASSIGNMENT', `⚡ Parallel fetch completed in ${Date.now() - startTime}ms`);
        debugLog('ASSIGNMENT', `✓ Got assignment: ${assignment.title}`);
        debugLog('ASSIGNMENT', `✓ Section: ${section.course_title || section.section_title}`);
        
        // Check for Google Drive/Docs links in assignment
        let googleDocLink = null;
        if (assignment.web_url && (assignment.web_url.includes('docs.google.com') || assignment.web_url.includes('drive.google.com'))) {
            googleDocLink = assignment.web_url;
            debugLog('ASSIGNMENT', `✓ Found Google Doc link: ${googleDocLink}`);
        }
        // Also check in LTI launch URL for Google Classroom assignments
        if (assignment.launch_url && (assignment.launch_url.includes('docs.google.com') || assignment.launch_url.includes('drive.google.com'))) {
            googleDocLink = assignment.launch_url;
            debugLog('ASSIGNMENT', `✓ Found Google Doc in launch URL: ${googleDocLink}`);
        }

        // Parse user grade
        let userGrade = null;
        if (gradesData) {
            const grades = gradesData.grades?.grade || gradesData.grade || [];
            const gradeArray = Array.isArray(grades) ? grades : [grades];
            if (gradeArray.length > 0) {
                userGrade = gradeArray[0];
                debugLog('ASSIGNMENT', `✓ Found grade: ${userGrade.grade} / ${userGrade.max_points}`);
            }
        }

        // Fetch grading categories to get category name
        let categoryName = 'Uncategorized';
        if (assignment.grading_category && assignment.grading_category !== '0') {
            try {
                const categoriesUrl = `${config.apiBase}/sections/${sectionId}/grading_categories`;
                const categoriesData = await makeOAuthRequest('GET', categoriesUrl, req.session.accessToken, null, {
                    cache: true,
                    cacheKey: getCacheKey(req.session.userId, `categories-${sectionId}`),
                    cacheTTL: CACHE_TTL.categories
                });
                const categories = categoriesData.grading_category || [];
                const category = categories.find(c => String(c.id) === String(assignment.grading_category));
                if (category) {
                    categoryName = category.title;
                }
            } catch (e) {
                debugLog('ASSIGNMENT', `Could not fetch categories: ${e.message}`);
            }
        }

        // Fetch user's submission for this assignment (if submittable)
        let userSubmission = null;
        const isSubmittable = assignment.allow_dropbox == 1 || assignment.allow_dropbox === '1';
        if (isSubmittable) {
            try {
                // Try to get user's submission from dropbox
                const submissionUrl = `${config.apiBase}/sections/${sectionId}/submissions/${assignmentId}/${req.session.userId}`;
                debugLog('ASSIGNMENT', `Fetching submission from: ${submissionUrl}`);
                const submissionData = await makeOAuthRequest('GET', submissionUrl, req.session.accessToken);
                debugLog('ASSIGNMENT', `  Submission response: ${JSON.stringify(submissionData).substring(0, 500)}`);

                // Check if there's a revision (actual submission)
                if (submissionData && submissionData.revision) {
                    const revisions = Array.isArray(submissionData.revision) ? submissionData.revision : [submissionData.revision];
                    if (revisions.length > 0) {
                        // Get the most recent revision
                        userSubmission = revisions[revisions.length - 1];
                        debugLog('ASSIGNMENT', `  Found submission with ${revisions.length} revision(s)`);
                    }
                }
            } catch (e) {
                debugLog('ASSIGNMENT', `Could not fetch submission: ${e.message}`);
                // 404 means no submission - that's OK
            }
        }

        debugLog('ASSIGNMENT', '✓ Rendering assignment page');

        // Apply adjusted due time from schedule if available
        loadSchedule(req.session.userId);
        const userSchedule = scheduleCache[req.session.userId] || {};
        const adjustedDueTimes = userSchedule.adjustedDueTimes || {};
        const adjusted = adjustedDueTimes[assignment.id];
        if (adjusted) {
            assignment.originalDue = assignment.due;
            assignment.due = adjusted.adjustedDue;
            assignment.dueAdjusted = true;
        }

        // Add time estimate
        const estimatedTime = estimateAssignmentTime(assignment);

        res.render('assignment', {
            assignment,
            section,
            categoryName,
            userGrade,
            userSubmission,
            estimatedTime,
            googleDocLink,
            authenticated: true,
            userName: req.session.userName
        });
    } catch (error) {
        debugLog('ASSIGNMENT', `✗ Error fetching assignment: ${error.message}`);
        res.render('error', { message: 'Failed to fetch assignment: ' + error.message });
    }
});

// API endpoints for frontend
app.get('/api/user', async (req, res) => {
    debugLog('API', '/api/user requested');
    if (!req.session.accessToken) {
        debugLog('API', 'Not authenticated');
        return res.status(401).json({ error: 'Not authenticated' });
    }

    // Cache user data for 10 minutes
    res.setHeader('Cache-Control', 'private, max-age=600');
    
    debugLog('API', `Returning user: ${req.session.userName}`);
    res.json({
        id: req.session.userId,
        name: req.session.userName
    });
});

// Browser authentication routes for quiz access
// Note: Browser features are DISABLED on Vercel due to resource limits

// Middleware to check if browser features are available
function requireBrowserFeatures(req, res, next) {
    if (!BROWSER_FEATURES_ENABLED) {
        return res.status(503).json({
            error: 'Browser features unavailable',
            message: 'Quiz viewer requires a headless browser which is not available on Vercel. Please run the app locally for quiz features.',
            vercel: IS_VERCEL
        });
    }
    if (!chromium) {
        return res.status(503).json({
            error: 'Playwright not installed',
            message: 'Please install Playwright to use browser features: npm install playwright'
        });
    }
    next();
}

// Helper to ensure browser is running (restoring from cookie if needed)
async function ensureBrowser(req) {
    if (browserContext && isLoggedIn) return true;

    const storedCookie = req.cookies.schoology_sess ? decryptToken(req.cookies.schoology_sess) : null;
    if (!storedCookie) return false;

    debugLog('BROWSER', 'Restoring browser session from cookie...');

    try {
        let launchOptions = {
            headless: false,
            args: ['--start-maximized']
        };

        if (IS_VERCEL && chromiumPack) {
            launchOptions = {
                args: chromiumPack.args,
                defaultViewport: chromiumPack.defaultViewport,
                executablePath: await chromiumPack.executablePath(),
                headless: chromiumPack.headless,
            };
        }

        browserInstance = await chromium.launch(launchOptions);

        let contextOptions = {
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        browserContext = await browserInstance.newContext(contextOptions);

        const cookies = [];
        const rawCookies = storedCookie.split(';');

        for (const c of rawCookies) {
            if (!c || !c.trim()) continue;

            if (c.includes('=')) {
                const parts = c.trim().split('=');
                const name = parts[0].trim();
                const value = parts.slice(1).join('=').trim();
                if (name && value) {
                    cookies.push({ name, value, domain: '.schoology.com', path: '/' });
                }
            } else {
                const domain = 'fuhsd.schoology.com';
                const hash = crypto.createHash('md5').update(domain).digest('hex');
                const name = 'SESS' + hash;
                cookies.push({ name, value: c.trim(), domain: '.schoology.com', path: '/' });
            }
        }

        if (cookies.length > 0) {
            await browserContext.addCookies(cookies);
        }

        isLoggedIn = true;
        return true;
    } catch (e) {
        debugLog('BROWSER', `Failed to restore browser: ${e.message}`);
        return false;
    }
}

// Helper to ensure quiz page is active (restoring from cookie URL if needed)
async function ensureQuizPage(req) {
    if (quizPage) return true;

    const url = req.cookies.current_assessment_url;
    if (!url) return false;

    debugLog('QUIZ', 'Restoring quiz page from cookie URL...');

    try {
        if (!browserContext) {
            const success = await ensureBrowser(req);
            if (!success) return false;
        }

        quizPage = await browserContext.newPage();
        await quizPage.setViewportSize({ width: 1280, height: 800 });

        await quizPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await quizPage.waitForTimeout(2000);

        // Click Resume/Start
        const resumeButton = await quizPage.$('input[value*="Resume"], button:has-text("Resume"), a:has-text("Resume")');
        if (resumeButton) {
            await resumeButton.click();
            await quizPage.waitForTimeout(3000);
        } else {
            const startButton = await quizPage.$('input[value*="Start Attempt"], input[value*="Start"], button:has-text("Start Attempt"), button:has-text("Start"), a:has-text("Start Attempt")');
            if (startButton) {
                await startButton.click();
                await quizPage.waitForTimeout(3000);
            }
        }

        return true;
    } catch (e) {
        debugLog('QUIZ', `Failed to restore page: ${e.message}`);
        return false;
    }
}

// Check browser login status
app.get('/api/browser/status', (req, res) => {
    if (!BROWSER_FEATURES_ENABLED) {
        return res.json({
            browserOpen: false,
            loggedIn: false,
            disabled: true,
            message: 'Browser features are disabled on Vercel'
        });
    }

    // Check if we have a stored cookie (for Vercel persistence)
    const storedCookie = req.cookies.schoology_sess ? decryptToken(req.cookies.schoology_sess) : null;

    res.json({
        browserOpen: browserInstance !== null,
        loggedIn: isLoggedIn || !!storedCookie
    });
});

// Start browser login (opens visible browser for Google SSO)
app.post('/api/browser/login', requireBrowserFeatures, express.json(), async (req, res) => {
    debugLog('BROWSER', 'Starting browser login...');
    const { schoologyCookie } = req.body;

    try {
        // Close existing browser if any
        if (browserInstance) {
            debugLog('BROWSER', 'Closing existing browser...');
            // Save state before closing if logged in (only locally)
            if (browserContext && isLoggedIn && !IS_VERCEL && fs) {
                try {
                    await browserContext.storageState({ path: BROWSER_STATE_PATH });
                    debugLog('BROWSER', '✓ Saved browser state before closing');
                } catch (e) {
                    debugLog('BROWSER', `Could not save state: ${e.message}`);
                }
            }
            await browserInstance.close();
            browserInstance = null;
            browserContext = null;
            isLoggedIn = false;
        }

        // Launch browser
        debugLog('BROWSER', `Launching browser (Vercel: ${IS_VERCEL})...`);

        let launchOptions = {
            headless: false,
            args: ['--start-maximized']
        };

        if (IS_VERCEL && chromiumPack) {
            // Memory optimization for Vercel (1024MB limit typical)
            const additionalArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Essential for serverless
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // Aggressive memory saving, might be unstable but good for static pages
                '--disable-extensions'
            ];

            launchOptions = {
                args: [...chromiumPack.args, ...additionalArgs],
                defaultViewport: chromiumPack.defaultViewport,
                executablePath: await chromiumPack.executablePath(),
                headless: chromiumPack.headless,
                ignoreHTTPSErrors: true,
            };
        }

        browserInstance = await chromium.launch(launchOptions);

        // Check if we have saved state to restore (only locally, not on Vercel)
        let contextOptions = {
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        if (!IS_VERCEL && fs && fs.existsSync(BROWSER_STATE_PATH)) {
            debugLog('BROWSER', '✓ Found saved browser state, restoring...');
            contextOptions.storageState = BROWSER_STATE_PATH;
        }

        browserContext = await browserInstance.newContext(contextOptions);

        // If cookie provided (e.g. on Vercel), inject it
        if (schoologyCookie) {
            debugLog('BROWSER', 'Injecting provided Schoology cookie...');

            const cookies = [];
            // Handle multiple cookies separated by semicolon
            const rawCookies = schoologyCookie.split(';');

            for (const c of rawCookies) {
                if (!c || !c.trim()) continue;

                if (c.includes('=')) {
                    // Format: name=value
                    const parts = c.trim().split('=');
                    const name = parts[0].trim();
                    const value = parts.slice(1).join('=').trim();

                    if (name && value) {
                        cookies.push({
                            name: name,
                            value: value,
                            domain: '.schoology.com', // Wildcard for subdomains
                            path: '/'
                        });
                    }
                } else {
                    // Format: just value (assume it's the SESS cookie)
                    // Calculate name: SESS + md5(domain)
                    // We use fuhsd.schoology.com for login, so calculate hash for that
                    const domain = 'fuhsd.schoology.com';
                    const hash = crypto.createHash('md5').update(domain).digest('hex');
                    const name = 'SESS' + hash;

                    cookies.push({
                        name: name,
                        value: c.trim(),
                        domain: '.schoology.com',
                        path: '/'
                    });
                }
            }

            if (cookies.length > 0) {
                debugLog('BROWSER', `Injecting ${cookies.length} cookies: ${cookies.map(c => c.name).join(', ')}`);
                await browserContext.addCookies(cookies);
                debugLog('BROWSER', `✓ Injected cookies successfully`);
            } else {
                debugLog('BROWSER', '⚠️ No valid cookies found in input');
            }
        }

        const page = await browserContext.newPage();

        // OPTIMIZATION: Block unnecessary resources
        await page.route('**/*', (route) => {
            const request = route.request();
            const resourceType = request.resourceType();

            // Block fonts and heavy media (we need images for screenshots, but maybe we can block larger ones?)
            // We KEEP images because the user interface relies on screenshots.
            if (resourceType === 'font' || resourceType === 'media') {
                return route.abort();
            }

            // Block analytics and trackers
            const url = request.url();
            if (url.includes('google-analytics') || url.includes('segment.io') || url.includes('hotjar')) {
                return route.abort();
            }

            route.continue();
        });

        // Navigate to Schoology
        debugLog('BROWSER', 'Navigating to fuhsd.schoology.com...');
        await page.goto('https://fuhsd.schoology.com', { waitUntil: 'networkidle' });

        // Check if already logged in from restored state or injected cookie
        const currentUrl = page.url();
        if (currentUrl.includes('schoology.com') &&
            !currentUrl.includes('login') &&
            !currentUrl.includes('google.com') &&
            !currentUrl.includes('accounts.')) {
            isLoggedIn = true;
            debugLog('BROWSER', '✓ Already logged in!');

            // Save the cookie for future serverless invocations
            if (schoologyCookie) {
                res.cookie('schoology_sess', encryptToken(schoologyCookie), {
                    httpOnly: true,
                    secure: IS_VERCEL,
                    sameSite: 'lax',
                    maxAge: 24 * 60 * 60 * 1000 // 24 hours
                });
            }

            res.json({
                success: true,
                alreadyLoggedIn: true,
                message: 'Browser opened and authenticated successfully!'
            });
        } else {
            res.json({
                success: true,
                message: IS_VERCEL
                    ? 'Browser opened but login failed. Please provide a valid Schoology SESS cookie.'
                    : 'Browser opened. Please complete Google SSO login in the browser window, then click "Check Login Status".'
            });
        }

    } catch (error) {
        debugLog('BROWSER', `✗ Error starting browser: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Check if login is complete
app.post('/api/browser/check-login', requireBrowserFeatures, async (req, res) => {
    debugLog('BROWSER', 'Checking browser login status...');

    if (!browserContext) {
        return res.json({
            success: false,
            loggedIn: false,
            message: 'Browser not started. Click "Start Browser Login" first.'
        });
    }

    try {
        const pages = browserContext.pages();
        const currentPage = pages.length > 0 ? pages[pages.length - 1] : null;
        const currentUrl = currentPage ? currentPage.url() : 'unknown';

        debugLog('BROWSER', `Current URL: ${currentUrl}`);

        // Check if we're on Schoology (not on login page)
        if (currentUrl.includes('schoology.com') &&
            !currentUrl.includes('login') &&
            !currentUrl.includes('google.com') &&
            !currentUrl.includes('accounts.')) {

            isLoggedIn = true;
            debugLog('BROWSER', '✓ User is logged in!');

            // Save browser state for persistence (only locally, not on Vercel)
            if (!IS_VERCEL && fs) {
                try {
                    await browserContext.storageState({ path: BROWSER_STATE_PATH });
                    debugLog('BROWSER', '✓ Browser state saved for future sessions');
                } catch (e) {
                    debugLog('BROWSER', `Could not save state: ${e.message}`);
                }
            }

            res.json({
                success: true,
                loggedIn: true,
                message: 'Successfully logged in! Session saved for future use.',
                currentUrl: currentUrl
            });
        } else {
            res.json({
                success: false,
                loggedIn: false,
                message: `Not fully logged in yet. Current URL: ${currentUrl}`,
                currentUrl: currentUrl
            });
        }
    } catch (error) {
        debugLog('BROWSER', `✗ Error checking login: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Close the browser
app.post('/api/browser/close', requireBrowserFeatures, async (req, res) => {
    debugLog('BROWSER', 'Closing browser...');

    try {
        if (browserInstance) {
            await browserInstance.close();
            browserInstance = null;
            browserContext = null;
            isLoggedIn = false;
            debugLog('BROWSER', '✓ Browser closed');
        }

        res.json({ success: true, message: 'Browser closed' });
    } catch (error) {
        debugLog('BROWSER', `✗ Error closing browser: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Fetch quiz using browser automation
// Store the current quiz page reference
let quizPage = null;

// Start quiz and take initial screenshot
app.post('/api/quiz/start', requireBrowserFeatures, express.json(), async (req, res) => {
    const { courseId, assignmentId } = req.body;
    debugLog('QUIZ-START', `=== Starting quiz for course: ${courseId}, assignment: ${assignmentId} ===`);

    // Check for stored cookie if not logged in
    const storedCookie = req.cookies.schoology_sess ? decryptToken(req.cookies.schoology_sess) : null;

    if ((!browserContext || !isLoggedIn) && !storedCookie) {
        debugLog('QUIZ-START', '✗ Browser not logged in and no stored cookie');
        return res.json({
            success: false,
            error: 'Browser not logged in. Please complete browser login first.',
            needsLogin: true
        });
    }

    try {
        // If browser not running but we have cookie, launch it (Vercel persistence)
        if ((!browserContext || !isLoggedIn) && storedCookie) {
            debugLog('QUIZ-START', 'Launching browser with stored cookie...');

            let launchOptions = {
                headless: false,
                args: ['--start-maximized']
            };

            if (IS_VERCEL && chromiumPack) {
                launchOptions = {
                    args: chromiumPack.args,
                    defaultViewport: chromiumPack.defaultViewport,
                    executablePath: await chromiumPack.executablePath(),
                    headless: chromiumPack.headless,
                };
            }

            browserInstance = await chromium.launch(launchOptions);

            let contextOptions = {
                viewport: { width: 1280, height: 800 },
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            };

            browserContext = await browserInstance.newContext(contextOptions);

            // Inject cookie
            debugLog('QUIZ-START', 'Injecting stored Schoology cookie...');
            const cookies = [];
            const rawCookies = storedCookie.split(';');

            for (const c of rawCookies) {
                if (!c || !c.trim()) continue;

                if (c.includes('=')) {
                    const parts = c.trim().split('=');
                    const name = parts[0].trim();
                    const value = parts.slice(1).join('=').trim();
                    if (name && value) {
                        cookies.push({ name, value, domain: '.schoology.com', path: '/' });
                    }
                } else {
                    const domain = 'fuhsd.schoology.com';
                    const hash = crypto.createHash('md5').update(domain).digest('hex');
                    const name = 'SESS' + hash;
                    cookies.push({ name, value: c.trim(), domain: '.schoology.com', path: '/' });
                }
            }

            if (cookies.length > 0) {
                await browserContext.addCookies(cookies);
                debugLog('QUIZ-START', `✓ Injected ${cookies.length} cookies`);
            }

            isLoggedIn = true;
        }

        // Close existing quiz page if any
        if (quizPage) {
            debugLog('QUIZ-START', 'Closing existing quiz page...');
            try { await quizPage.close(); } catch (e) { }
            quizPage = null;
        }

        // Create a new page for the quiz
        debugLog('QUIZ-START', 'Creating new page...');
        quizPage = await browserContext.newPage();
        debugLog('QUIZ-START', '✓ Page created');

        // Set viewport for consistent screenshots
        await quizPage.setViewportSize({ width: 1280, height: 800 });
        debugLog('QUIZ-START', '✓ Viewport set to 1280x800');

        // Navigate to the assessment page
        const assessmentUrl = `https://fuhsd.schoology.com/course/${courseId}/assessments/${assignmentId}`;

        // Save URL for session restoration on Vercel
        res.cookie('current_assessment_url', assessmentUrl, {
            httpOnly: true,
            secure: IS_VERCEL,
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000
        });

        debugLog('QUIZ-START', `Navigating to: ${assessmentUrl}`);

        // Use domcontentloaded instead of networkidle to avoid timeout
        await quizPage.goto(assessmentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        debugLog('QUIZ-START', '✓ Initial navigation complete (domcontentloaded)');

        // Wait a bit for dynamic content
        await quizPage.waitForTimeout(2000);
        debugLog('QUIZ-START', '✓ Waited 2s for dynamic content');

        // Log current URL
        debugLog('QUIZ-START', `Current URL: ${quizPage.url()}`);

        // Check for Resume or Start Attempt button
        let startedAssessment = false;

        // Try to find and click Resume button first
        debugLog('QUIZ-START', 'Looking for Resume button...');
        const resumeButton = await quizPage.$('input[value*="Resume"], button:has-text("Resume"), a:has-text("Resume")');
        if (resumeButton) {
            debugLog('QUIZ-START', '✓ Found Resume button, clicking...');
            await resumeButton.click();
            debugLog('QUIZ-START', 'Waiting for page after Resume click...');
            await quizPage.waitForTimeout(3000);
            debugLog('QUIZ-START', `✓ After Resume click, URL: ${quizPage.url()}`);
            startedAssessment = true;
        } else {
            debugLog('QUIZ-START', '✗ No Resume button found');
        }

        // If no resume, try Start Attempt
        if (!startedAssessment) {
            debugLog('QUIZ-START', 'Looking for Start button...');
            const startButton = await quizPage.$('input[value*="Start Attempt"], input[value*="Start"], button:has-text("Start Attempt"), button:has-text("Start"), a:has-text("Start Attempt")');
            if (startButton) {
                debugLog('QUIZ-START', '✓ Found Start button, clicking...');
                await startButton.click();
                debugLog('QUIZ-START', 'Waiting for page after Start click...');
                await quizPage.waitForTimeout(3000);
                debugLog('QUIZ-START', `✓ After Start click, URL: ${quizPage.url()}`);
                startedAssessment = true;
            } else {
                debugLog('QUIZ-START', '✗ No Start button found');
            }
        }

        if (!startedAssessment) {
            debugLog('QUIZ-START', 'No start/resume button found, checking if already in assessment...');
            const pageContent = await quizPage.content();
            const hasQuestionContent = pageContent.includes('question') || pageContent.includes('cad-') || pageContent.includes('assessment');
            debugLog('QUIZ-START', `Has question content: ${hasQuestionContent}`);

            if (!hasQuestionContent) {
                debugLog('QUIZ-START', '✗ Not in assessment, returning error');
                await quizPage.close();
                quizPage = null;
                return res.json({
                    success: false,
                    error: 'Could not find Start or Resume button. The assessment may not be available.',
                    currentUrl: assessmentUrl
                });
            }
            debugLog('QUIZ-START', '✓ Already appears to be in assessment');
        }

        // Extract quiz content instead of screenshot
        debugLog('QUIZ-START', 'Extracting quiz content...');
        const content = await extractQuizContent(quizPage);

        // Check for navigation buttons
        debugLog('QUIZ-START', 'Checking navigation buttons...');
        const navState = await checkNavButtons(quizPage);
        debugLog('QUIZ-START', `✓ Nav state: canGoBack=${navState.canGoBack}, canGoNext=${navState.canGoNext}, isReview=${navState.isReview}`);

        debugLog('QUIZ-START', '=== Quiz started successfully ===');

        res.json({
            success: true,
            content: content,
            canGoBack: navState.canGoBack,
            canGoNext: navState.canGoNext,
            isReview: navState.isReview,
            currentUrl: quizPage.url()
        });

    } catch (error) {
        debugLog('QUIZ-START', `✗ ERROR: ${error.message}`);
        debugLog('QUIZ-START', `Stack: ${error.stack}`);
        if (quizPage) {
            try { await quizPage.close(); } catch (e) { }
            quizPage = null;
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

// Navigate to next question
app.post('/api/quiz/next', requireBrowserFeatures, express.json(), async (req, res) => {
    debugLog('QUIZ-NEXT', '=== Navigating to next question ===');

    // Attempt Rehydration (CRITICAL for Vercel)
    const { quizUrl } = req.body || {};
    try {
        await rehydrateQuizPage(quizUrl, req.cookies?.schoology_sess);
    } catch (e) {
        debugLog('QUIZ-NEXT', `Rehydration failed: ${e.message}`);
    }

    if (!quizPage) {
        debugLog('QUIZ-NEXT', '✗ No active quiz page');
        return res.json({
            success: false,
            error: 'No active quiz session. Please start a quiz first.'
        });
    }

    try {
        debugLog('QUIZ-NEXT', `Current URL: ${quizPage.url()}`);

        // Find and click the Next button
        debugLog('QUIZ-NEXT', 'Looking for Next button...');
        const nextButton = await quizPage.$('input[value="Next"], input[value*="Next"], button:has-text("Next"), a:has-text("Next")');

        if (!nextButton) {
            debugLog('QUIZ-NEXT', '✗ No Next button found');
            return res.json({
                success: false,
                error: 'No Next button found on the page.'
            });
        }

        debugLog('QUIZ-NEXT', '✓ Found Next button, clicking...');
        await nextButton.click();
        debugLog('QUIZ-NEXT', 'Waiting after click...');
        await quizPage.waitForTimeout(2000);
        debugLog('QUIZ-NEXT', `✓ After click, URL: ${quizPage.url()}`);

        // Extract quiz content
        debugLog('QUIZ-NEXT', 'Extracting quiz content...');
        const content = await extractQuizContent(quizPage);

        // Check for navigation buttons
        const navState = await checkNavButtons(quizPage);
        debugLog('QUIZ-NEXT', `✓ Nav state: canGoBack=${navState.canGoBack}, canGoNext=${navState.canGoNext}`);

        res.json({
            success: true,
            content: content,
            canGoBack: navState.canGoBack,
            canGoNext: navState.canGoNext,
            isReview: navState.isReview,
            currentUrl: quizPage.url()
        });

    } catch (error) {
        debugLog('QUIZ-NEXT', `✗ ERROR: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Navigate to previous question
app.post('/api/quiz/prev', requireBrowserFeatures, express.json(), async (req, res) => {
    debugLog('QUIZ-PREV', '=== Navigating to previous question ===');

    // Attempt Rehydration (CRITICAL for Vercel)
    const { quizUrl } = req.body || {};
    try {
        await rehydrateQuizPage(quizUrl, req.cookies?.schoology_sess);
    } catch (e) {
        debugLog('QUIZ-PREV', `Rehydration failed: ${e.message}`);
    }

    if (!quizPage) {
        debugLog('QUIZ-PREV', '✗ No active quiz page');
        return res.json({
            success: false,
            error: 'No active quiz session. Please start a quiz first.'
        });
    }

    try {
        debugLog('QUIZ-PREV', `Current URL: ${quizPage.url()}`);

        // Find and click the Previous/Back button
        debugLog('QUIZ-PREV', 'Looking for Previous/Back button...');
        const prevButton = await quizPage.$('input[value="Previous"], input[value*="Previous"], input[value="Back"], input[value*="Back"], button:has-text("Previous"), button:has-text("Back"), a:has-text("Previous"), a:has-text("Back")');

        if (!prevButton) {
            debugLog('QUIZ-PREV', '✗ No Previous/Back button found');
            return res.json({
                success: false,
                error: 'No Previous/Back button found on the page.'
            });
        }

        debugLog('QUIZ-PREV', '✓ Found Previous button, clicking...');
        await prevButton.click();
        debugLog('QUIZ-PREV', 'Waiting after click...');
        await quizPage.waitForTimeout(2000);
        debugLog('QUIZ-PREV', `✓ After click, URL: ${quizPage.url()}`);

        // Extract quiz content
        debugLog('QUIZ-PREV', 'Extracting quiz content...');
        const content = await extractQuizContent(quizPage);

        // Check for navigation buttons
        const navState = await checkNavButtons(quizPage);
        debugLog('QUIZ-PREV', `✓ Nav state: canGoBack=${navState.canGoBack}, canGoNext=${navState.canGoNext}`);

        res.json({
            success: true,
            content: content,
            canGoBack: navState.canGoBack,
            canGoNext: navState.canGoNext,
            isReview: navState.isReview,
            currentUrl: quizPage.url()
        });

    } catch (error) {
        debugLog('QUIZ-PREV', `✗ ERROR: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get current screenshot without navigation
app.get('/api/quiz/screenshot', requireBrowserFeatures, async (req, res) => {
    if (!quizPage) {
        return res.json({
            success: false,
            error: 'No active quiz session. Please start a quiz first.'
        });
    }

    try {
        const screenshot = await quizPage.screenshot({ type: 'png', fullPage: false });
        const screenshotBase64 = screenshot.toString('base64');
        const navState = await checkNavButtons(quizPage);

        res.json({
            success: true,
            screenshot: screenshotBase64,
            canGoBack: navState.canGoBack,
            canGoNext: navState.canGoNext,
            isReview: navState.isReview,
            currentUrl: quizPage.url()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Submit quiz - click Review, then Finish, then confirm
app.post('/api/quiz/submit', requireBrowserFeatures, async (req, res) => {
    debugLog('QUIZ-SUBMIT', '=== Submitting quiz ===');

    // Ensure we have a page (restore if needed)
    await ensureQuizPage(req);

    if (!quizPage) {
        debugLog('QUIZ-SUBMIT', '✗ No active quiz page');
        return res.json({
            success: false,
            error: 'No active quiz. Please load a quiz first.'
        });
    }

    try {
        const log = [];

        // Helper to find element across all frames
        const findInFrames = async (page, selector) => {
            // Check main page
            let element = await page.$(selector);
            if (element) return { element, frame: page.mainFrame() };

            // Check all frames recursively
            const frames = page.frames();
            debugLog('QUIZ-SUBMIT', `Searching ${frames.length} frames for ${selector}...`);

            for (const frame of frames) {
                try {
                    const el = await frame.$(selector);
                    if (el) {
                        // verify visibility
                        const isVisible = await frame.evaluate((e) => {
                            if (!e) return false;
                            const style = window.getComputedStyle(e);
                            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                        }, el);

                        if (isVisible) {
                            return { element: el, frame };
                        }
                    }
                } catch (e) {
                    // Start of frame access error handling
                }
            }
            return null;
        };

        // Step 1: Click Review button
        debugLog('QUIZ-SUBMIT', 'Looking for Review button...');

        // Direct DOM evaluation to find the specific element and debug
        const reviewClickResult = await quizPage.evaluate(async () => {
            const selector = '.lrn_btn.test-review-screen';
            const log = [];

            // Try specific selector first
            const el = document.querySelector(selector);
            if (el) {
                // Ensure visible
                el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
                el.click();
                return { success: true, msg: 'Found and clicked via specific selector' };
            }

            // DEBUG: List all buttons to see what's actually there
            const allBtns = Array.from(document.querySelectorAll('.lrn_btn, button'));
            const btnInfo = allBtns.map(b => ({
                text: b.innerText.trim().substring(0, 20),
                classes: b.className,
                visible: b.offsetWidth > 0
            }));

            // Find anything that looks like "Review"
            const reviewCandidates = allBtns.filter(b =>
                b.innerText.toLowerCase().includes('review') ||
                b.className.includes('review')
            );

            if (reviewCandidates.length > 0) {
                // Try clicking the first visible candidate
                for (const btn of reviewCandidates) {
                    if (btn.offsetWidth > 0) {
                        btn.click();
                        return { success: true, msg: `Clicked fallback review button: ${btn.className}` };
                    }
                }
            }

            return {
                success: false,
                error: 'Review button not found',
                debugInfo: JSON.stringify(btnInfo.slice(0, 10)) // Log first 10 buttons for context
            };
        });

        if (reviewClickResult.success) {
            log.push(reviewClickResult.msg);
            debugLog('QUIZ-SUBMIT', `✓ ${reviewClickResult.msg}`);
            await quizPage.waitForTimeout(3000);
        } else {
            // If main page fail, try the recursive search (user said no iframe, but fallback is safe)
            debugLog('QUIZ-SUBMIT', `Main page check failed: ${reviewClickResult.error}`);
            debugLog('QUIZ-SUBMIT', `Buttons found on page: ${reviewClickResult.debugInfo}`);

            log.push('Main page search failed, trying deep frame search...');
            const reviewSelector = '.lrn_btn.test-review-screen, button[data-action="review"], button:has-text("Review")';
            const reviewResult = await findInFrames(quizPage, reviewSelector);

            if (reviewResult) {
                log.push(`Found Review button in frame: ${reviewResult.frame.url()}`);
                await reviewResult.element.click();
                await quizPage.waitForTimeout(3000);
                log.push('✓ Clicked Review (in frame)');
            } else {
                log.push('FATAL: Review button NOT found anywhere.');
                debugLog('QUIZ-SUBMIT', 'FATAL: Review button NOT found anywhere.');
            }
        }

        // Step 2: Click Finish/Submit button
        debugLog('QUIZ-SUBMIT', 'Looking for Finish/Submit button...');
        await quizPage.waitForTimeout(2000);

        const finishSelector = 'button[data-action="finish"], button:has-text("Finish"), button:has-text("Submit"), .test-submit, [class*="finish"], [class*="submit"], .lrn_btn_finish';
        const finishResult = await findInFrames(quizPage, finishSelector);

        if (finishResult) {
            log.push(`Found Finish/Submit button in frame: ${finishResult.frame.url()}`);
            debugLog('QUIZ-SUBMIT', 'Clicking Finish/Submit button...');
            await finishResult.element.click();
            await quizPage.waitForTimeout(2000);
            log.push('✓ Clicked Finish/Submit');
        } else {
            log.push('No Finish/Submit button found');
            debugLog('QUIZ-SUBMIT', 'No Finish/Submit button found');
        }

        // Step 3: Handle confirmation dialog (Yes/OK/Confirm)
        debugLog('QUIZ-SUBMIT', 'Looking for confirmation dialog...');
        await quizPage.waitForTimeout(1000);

        // Look for confirmation buttons in dialogs/modals
        const confirmSelectors = [
            'button:has-text("Yes")',
            'button:has-text("OK")',
            'button:has-text("Confirm")',
            'button:has-text("Submit")',
            '.modal button.btn-primary',
            '.dialog button.btn-primary',
            '[role="dialog"] button:has-text("Yes")',
            '[role="dialog"] button:has-text("OK")',
            '.lrn-dialog button:has-text("Yes")',
            '.lrn-dialog button:has-text("OK")',
            '.lrn button:has-text("Yes")',
            '.confirmation button:has-text("Yes")'
        ];

        for (const selector of confirmSelectors) {
            try {
                const confirmBtn = await quizPage.$(selector);
                if (confirmBtn) {
                    const isVisible = await confirmBtn.isVisible();
                    if (isVisible) {
                        log.push(`Found confirmation button (${selector}), clicking...`);
                        debugLog('QUIZ-SUBMIT', `Clicking confirmation: ${selector}`);
                        await confirmBtn.click();
                        await quizPage.waitForTimeout(2000);
                        log.push('✓ Confirmed submission');
                        break;
                    }
                }
            } catch (e) {
                // Continue trying other selectors
            }
        }

        // Take final screenshot
        await quizPage.waitForTimeout(2000);
        let finalScreenshot = null;

        debugLog('QUIZ-SUBMIT', '✓ Quiz submission complete');
        log.push('Quiz submission process complete');

        res.json({
            success: true,
            message: 'Quiz submitted!',
            log: log,
            screenshot: finalScreenshot ? finalScreenshot.toString('base64') : null
        });

    } catch (error) {
        debugLog('QUIZ-SUBMIT', `✗ Error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Close quiz session
app.post('/api/quiz/close', requireBrowserFeatures, async (req, res) => {
    debugLog('QUIZ-CLOSE', 'Closing quiz session...');

    if (quizPage) {
        try {
            await quizPage.close();
        } catch (e) {
            // Ignore errors when closing
        }
        quizPage = null;
    }

    res.json({ success: true, message: 'Quiz session closed' });
});

// Get current quiz content (for refreshing display after interactions)
app.get('/api/quiz/content', requireBrowserFeatures, async (req, res) => {
    debugLog('QUIZ-CONTENT', 'Fetching current quiz content...');

    // Attempt Rehydration (CRITICAL for Vercel)
    const quizUrl = req.query.quizUrl;
    if (quizUrl) {
        try {
            await rehydrateQuizPage(quizUrl, req.cookies?.schoology_sess);
        } catch (e) {
            debugLog('QUIZ-CONTENT', `Rehydration failed: ${e.message}`);
        }
    }

    if (!quizPage) {
        return res.json({
            success: false,
            error: 'No active quiz page'
        });
    }

    try {
        const content = await extractQuizContent(quizPage);
        const navState = await checkNavButtons(quizPage);

        debugLog('QUIZ-CONTENT', `✓ Content extracted (${content.html.length} chars)`);

        res.json({
            success: true,
            content: content,
            canGoBack: navState.canGoBack,
            canGoNext: navState.canGoNext
        });
    } catch (error) {
        debugLog('QUIZ-CONTENT', `✗ Error: ${error.message}`);
        res.json({
            success: false,
            error: error.message
        });
    }
});

// ==========================================
// VERCEL STATELESS HELPERS
// ==========================================

// Helper: Timeout wrapper
const withTimeout = (promise, ms, fallback) => {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => {
            debugLog('TIMEOUT', `Operation timed out after ${ms}ms`);
            resolve(fallback);
        }, ms))
    ]);
};

// Helper: Ensure Browser is Active (Vercel Rehydration)
const rehydrateQuizPage = async (reqUrl, reqCookie) => {
    // 1. Check if existing session is valid
    if (quizPage && !quizPage.isClosed()) {
        if (quizPage.url().includes('schoology.com')) {
            return true;
        }
    }

    debugLog('VERCEL', 'Browser session lost/closed. Rehydrating...');

    // 2. Launch Browser if needed
    if (!browserInstance) {
        const launchOptions = IS_VERCEL && chromiumPack ? {
            args: [...chromiumPack.args, '--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox', '--no-zygote', '--single-process'],
            defaultViewport: chromiumPack.defaultViewport,
            executablePath: await chromiumPack.executablePath(),
            headless: chromiumPack.headless,
            ignoreHTTPSErrors: true
        } : { headless: false, args: ['--start-maximized'] };

        browserInstance = await chromium.launch(launchOptions);
        browserContext = await browserInstance.newContext();

        // 3. Inject Cookie
        if (reqCookie) {
            const decrypted = decryptToken(reqCookie);
            if (decrypted) {
                const cookies = [{
                    name: 'SESS' + crypto.createHash('md5').update('fuhsd.schoology.com').digest('hex'),
                    value: decrypted,
                    domain: '.schoology.com',
                    path: '/'
                }];
                await browserContext.addCookies(cookies);
                isLoggedIn = true;
            }
        }
    }

    // 4. Create Page if needed
    if (!quizPage || quizPage.isClosed()) {
        quizPage = await browserContext.newPage();
        await quizPage.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (type === 'font' || type === 'media' || route.request().url().includes('google-analytics')) route.abort();
            else route.continue();
        });
    }

    // 5. Navigate to Quiz
    if (reqUrl && reqUrl.startsWith('http') && quizPage.url() !== reqUrl) {
        debugLog('VERCEL', `Navigating to ${reqUrl}...`);
        try {
            await quizPage.setViewportSize({ width: 1920, height: 1080 }); // Force desktop
            await quizPage.goto(reqUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Check if we got redirected to login
            if (quizPage.url().includes('login') || quizPage.url().includes('google.com')) {
                debugLog('VERCEL', '⚠️ Redirected to Login page! Session might be invalid.');
                throw new Error('Redirected to login page. Please refresh your session.');
            }

            // Wait for quiz content to appear
            debugLog('VERCEL', 'Waiting for quiz content...');
            const quizSelectors = [
                '.question-view',
                '.assessment-content',
                '.slides-container',
                '.question-body',
                '#assessment-view',
                '.assessment-player',
                'body' // Fallback
            ];
            // Try to wait for any of these
            try {
                await Promise.race([
                    quizPage.waitForSelector(quizSelectors.join(','), { timeout: 15000 }),
                    quizPage.waitForSelector('iframe', { timeout: 10000 })
                ]);
                debugLog('VERCEL', `✓ Quiz content detected. URL: ${quizPage.url()}`);
            } catch (waitError) {
                debugLog('VERCEL', `⚠️ Timeout waiting for specific selectors. Current URL: ${quizPage.url()}`);
            }

        } catch (navError) {
            debugLog('VERCEL', `✗ Navigation failed: ${navError.message}`);
            throw navError;
        }
    }
    return true;
};

// Perform a click on the actual quiz page (using index-based targeting)
app.post('/api/quiz/click-element', requireBrowserFeatures, express.json(), async (req, res) => {
    const { type, index, quizUrl } = req.body;

    // Stateless Rehydration
    try {
        await rehydrateQuizPage(quizUrl, req.cookies?.schoology_sess);
    } catch (e) { }

    if (!quizPage) return res.json({ success: false, error: 'No active quiz page' });

    try {
        const result = await quizPage.evaluate((args) => {
            const { type, index } = args;

            // Robust visibility check matching extractQuizContent
            const isVisible = (el) => {
                if (!el) return false;
                // Use native checkVisibility if available
                if (el.checkVisibility) {
                    return el.checkVisibility({
                        checkOpacity: true,
                        checkVisibilityCSS: true
                    });
                }
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            };

            // Capture debug logs
            const debugInfo = [];

            // Find container logic matching extractQuizContent
            let container = null;
            const activeSelectors = [
                '.question-view.active',
                '.slide.active',
                '.question-container.current',
                '.question-body:not([style*="display: none"])'
            ];

            for (const s of activeSelectors) {
                const el = document.querySelector(s);
                if (el && isVisible(el)) {
                    container = el;
                    debugInfo.push(`Found active container: ${s}`);
                    break;
                }
            }

            // Fallback strategy if no active container found
            if (!container) {
                const genericSelectors = ['.question-view', '.question-body', '.slides-container .slide', '.assessment-content > div'];
                for (const s of genericSelectors) {
                    const elements = document.querySelectorAll(s);
                    for (const el of elements) {
                        if (isVisible(el)) {
                            container = el;
                            debugInfo.push(`Found generic container: ${s}`);
                            break;
                        }
                    }
                    if (container) break;
                }
            }

            // Final fallback
            if (!container) {
                container = document.body;
                debugInfo.push('Fallback to document.body');
            }

            let elements;
            let selector = '';
            if (type === 'radio') {
                selector = 'input[type="radio"]';
                elements = Array.from(container.querySelectorAll(selector));
            } else if (type === 'checkbox') {
                selector = 'input[type="checkbox"]';
                elements = Array.from(container.querySelectorAll(selector));
            } else {
                return { success: false, error: 'Unknown type' };
            }

            // Filter by visibility to match extraction
            const visibleElements = elements.filter(isVisible);

            debugInfo.push(`Total ${selector} in container: ${elements.length}`);
            debugInfo.push(`Visible ${selector}: ${visibleElements.length}`);

            if (index >= 0 && index < visibleElements.length) {
                const el = visibleElements[index];
                el.click();
                return { success: true, debug: debugInfo };
            }

            return {
                success: false,
                error: `Element not found at index ${index} (found ${visibleElements.length} visible)`,
                debug: debugInfo
            };
        }, { type, index });

        if (result.success) {
            // Wait for potential auto-save or state update
            await quizPage.waitForTimeout(500);
            res.json({ success: true });
        } else {
            const debugInfo = result.debug ? result.debug.join(' | ') : 'No debug info';
            debugLog('SYNC-CLICK', `FAILED: ${result.error}`);
            debugLog('SYNC-CLICK', `DEBUG INFO: ${debugInfo}`);
            res.json({
                success: false,
                error: `${result.error}. Debug: ${debugInfo}`
            });
        }
    } catch (error) {
        debugLog('SYNC-CLICK', `Error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Sync text input (using index-based targeting)
app.post('/api/quiz/type-text', requireBrowserFeatures, express.json(), async (req, res) => {
    const { type, index, text, quizUrl } = req.body;
    debugLog('SYNC-TYPE', `Typing "${text}" into ${type} at index ${index}`);

    // Stateless Rehydration
    try {
        await rehydrateQuizPage(quizUrl, req.cookies?.schoology_sess);
    } catch (e) { }

    if (!quizPage) {
        return res.json({ success: false, error: 'No active quiz page' });
    }

    try {
        // We use Puppeteer to find the element handle so we can use page.type for realistic typing
        // But first we need to find it using evaluate logic to match the container
        const boundingBox = await quizPage.evaluate((args) => {
            const { index } = args;

            // Robust visibility check
            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            };

            // Find active container (standardized)
            let container = null;
            const activeSelectors = ['.question-view.active', '.slide.active', '.question-container.current', '.question-body:not([style*="display: none"])'];
            for (const s of activeSelectors) {
                const el = document.querySelector(s);
                if (el && isVisible(el)) {
                    container = el;
                    break;
                }
            }
            if (!container) container = document.body;

            // inputs only (text/textarea)
            const inputs = Array.from(container.querySelectorAll('input[type="text"], textarea'));
            const visibleInputs = inputs.filter(isVisible);

            if (index >= 0 && index < visibleInputs.length) {
                const el = visibleInputs[index];
                // Mark it so we can find it with Puppeteer handle
                el.setAttribute('data-puppeteer-typing-target', 'true');
                return true;
            }
            return false;
        }, { index });

        if (boundingBox) {
            const inputHandle = await quizPage.$('[data-puppeteer-typing-target]');
            if (inputHandle) {
                // Clear existing text? Not easily done with just type. 
                // Triple click to select all then backspace is a common strategy
                await inputHandle.click({ clickCount: 3 });
                await inputHandle.press('Backspace');
                await inputHandle.type(text, { delay: 50 }); // Type with slight delay

                // Clean up attribute
                await quizPage.evaluate(() => {
                    document.querySelectorAll('[data-puppeteer-typing-target]').forEach(e => e.removeAttribute('data-puppeteer-typing-target'));
                });

                // Wait for state save
                await quizPage.waitForTimeout(500);
                res.json({ success: true });
            } else {
                res.json({ success: false, error: 'Input handle not found' });
            }
        } else {
            res.json({ success: false, error: 'Input not found by index' });
        }
    } catch (error) {
        debugLog('SYNC-TYPE', `Error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Sync select option (using index-based targeting)
app.post('/api/quiz/select-option', requireBrowserFeatures, express.json(), async (req, res) => {
    const { index, value, quizUrl } = req.body;
    debugLog('SYNC-SELECT', `Selecting "${value}" in dropdown index ${index}`);

    // Stateless Rehydration
    try {
        await rehydrateQuizPage(quizUrl, req.cookies?.schoology_sess);
    } catch (e) { }

    if (!quizPage) {
        return res.json({ success: false, error: 'No active quiz page' });
    }

    try {
        const result = await quizPage.evaluate((args) => {
            const { index, value } = args;

            // Robust visibility check
            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            };

            // Find active container (standardized)
            let container = null;
            const activeSelectors = ['.question-view.active', '.slide.active', '.question-container.current', '.question-body:not([style*="display: none"])'];
            for (const s of activeSelectors) {
                const el = document.querySelector(s);
                if (el && isVisible(el)) {
                    container = el;
                    break;
                }
            }
            if (!container) container = document.body;

            const selects = Array.from(container.querySelectorAll('select'));
            const visibleSelects = selects.filter(isVisible);

            if (index >= 0 && index < visibleSelects.length) {
                const el = visibleSelects[index];
                el.value = value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true };
            }
            return { success: false, error: 'Select not found at index' };
        }, { index, value });

        if (result.success) {
            await quizPage.waitForTimeout(500);
        }
        res.json(result);
    } catch (error) {
        debugLog('SYNC-SELECT', `Error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Perform drag-drop on the actual quiz
app.post('/api/quiz/drag-drop', requireBrowserFeatures, express.json(), async (req, res) => {
    const { dragText, dropIndex } = req.body;
    debugLog('SYNC-DRAG', `Dragging "${dragText}" to drop zone ${dropIndex}`);

    if (!quizPage) {
        return res.json({ success: false, error: 'No active quiz page' });
    }

    try {
        // Find the drag button and drop zone
        const elements = await quizPage.evaluate((args) => {
            const { text, idx } = args;
            const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 &&
                    style.display !== 'none' && style.visibility !== 'hidden';
            };

            // Find active container
            let container = document.body;
            const activeSelectors = ['.question-view.active', '.slide.active', '.question-container.current'];
            for (const s of activeSelectors) {
                const el = document.querySelector(s);
                if (el && isVisible(el)) {
                    container = el;
                    break;
                }
            }

            // Find visible drag buttons
            const drags = Array.from(container.querySelectorAll('.lrn_btn_drag')).filter(isVisible);
            const drops = Array.from(container.querySelectorAll('.lrn_dropzone')).filter(isVisible);

            // Find the matching drag by text
            const textNorm = text.trim().toLowerCase().replace(/[^\w\s]/g, '');
            let dragIdx = -1;
            for (let i = 0; i < drags.length; i++) {
                const btnText = drags[i].textContent.trim().toLowerCase().replace(/[^\w\s]/g, '');
                if (btnText === textNorm || btnText.includes(textNorm) || textNorm.includes(btnText)) {
                    dragIdx = i;
                    break;
                }
            }

            // Mark elements for Puppeteer
            if (dragIdx >= 0) drags[dragIdx].setAttribute('data-drag-target', 'true');
            if (idx < drops.length) drops[idx].setAttribute('data-drop-target', 'true');

            return {
                dragFound: dragIdx >= 0,
                dropFound: idx < drops.length,
                dragText: dragIdx >= 0 ? drags[dragIdx].textContent.trim() : null
            };
        }, { text: dragText, idx: dropIndex });

        if (!elements.dragFound) {
            debugLog('SYNC-DRAG', `✗ Drag item "${dragText}" not found`);
            return res.json({ success: false, error: 'Drag item not found' });
        }
        if (!elements.dropFound) {
            debugLog('SYNC-DRAG', `✗ Drop zone ${dropIndex} not found`);
            return res.json({ success: false, error: 'Drop zone not found' });
        }

        // Get the marked elements
        const dragBtn = await quizPage.$('[data-drag-target]');
        const dropZone = await quizPage.$('[data-drop-target]');

        if (!dragBtn || !dropZone) {
            debugLog('SYNC-DRAG', '✗ Could not find marked elements');
            return res.json({ success: false, error: 'Could not find elements' });
        }

        // Get positions and perform drag
        await dragBtn.scrollIntoViewIfNeeded();
        await quizPage.waitForTimeout(100);
        const dragBox = await dragBtn.boundingBox();

        await dropZone.scrollIntoViewIfNeeded();
        await quizPage.waitForTimeout(100);
        const dropBox = await dropZone.boundingBox();

        if (dragBox && dropBox) {
            const startX = dragBox.x + dragBox.width / 2;
            const startY = dragBox.y + dragBox.height / 2;
            const endX = dropBox.x + dropBox.width / 2;
            const endY = dropBox.y + dropBox.height / 2;

            // Perform drag
            await quizPage.mouse.move(startX, startY);
            await quizPage.waitForTimeout(100);
            await quizPage.mouse.down();
            await quizPage.waitForTimeout(150);
            await quizPage.mouse.move(endX, endY, { steps: 20 });
            await quizPage.waitForTimeout(150);
            await quizPage.mouse.up();
            await quizPage.waitForTimeout(300);

            debugLog('SYNC-DRAG', `✓ Dragged "${elements.dragText}" to zone ${dropIndex}`);
        }

        // Clean up markers
        await quizPage.evaluate(() => {
            document.querySelectorAll('[data-drag-target]').forEach(el => el.removeAttribute('data-drag-target'));
            document.querySelectorAll('[data-drop-target]').forEach(el => el.removeAttribute('data-drop-target'));
        });

        res.json({ success: true, message: `Dragged "${elements.dragText}" to zone ${dropIndex}` });
    } catch (error) {
        debugLog('SYNC-DRAG', `✗ Error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

// Ask AI to solve the current question using Cerebras
app.post('/api/quiz/ask-ai', requireBrowserFeatures, express.json(), async (req, res) => {
    debugLog('ASK-AI', '=== Asking AI to solve question ===');

    const apiKey = process.env.CEREBRAS_API_KEY;
    if (!apiKey || apiKey === 'your_cerebras_api_key_here') {
        debugLog('ASK-AI', '✗ No Cerebras API key configured');
        return res.json({
            success: false,
            error: 'Cerebras API key not configured. Add CEREBRAS_API_KEY to your .env file.'
        });
    }

    // Attempt Rehydration (CRITICAL for Vercel)
    const { quizUrl } = req.body || {};
    try {
        await rehydrateQuizPage(quizUrl, req.cookies?.schoology_sess);
    } catch (e) {
        debugLog('ASK-AI', `Rehydration failed: ${e.message}`);
        return res.json({
            success: false,
            error: `Failed to rehydrate quiz session: ${e.message}`
        });
    }

    if (!quizPage) {
        debugLog('ASK-AI', '✗ No active quiz page after rehydration');
        return res.json({
            success: false,
            error: 'No active quiz. Please load a quiz first.'
        });
    }

    try {
        // Get additional context from request
        const { quizContext, questionContext, contextImages } = req.body || {};
        debugLog('ASK-AI', `Quiz context: ${quizContext ? quizContext.substring(0, 100) + '...' : 'none'}`);
        debugLog('ASK-AI', `Question context: ${questionContext ? questionContext.substring(0, 100) + '...' : 'none'}`);
        debugLog('ASK-AI', `Context images: ${contextImages ? contextImages.length : 0} image(s) provided`);

        // Extract text content from the quiz page
        debugLog('ASK-AI', 'Extracting text content for AI...');
        const content = await extractQuizContent(quizPage);

        if (!content || !content.text) {
            debugLog('ASK-AI', '✗ Failed to extract content');
            return res.json({
                success: false,
                error: 'Failed to extract question content from the page.'
            });
        }

        debugLog('ASK-AI', `✓ Content extracted, length: ${content.text.length} chars`);
        debugLog('ASK-AI', `✓ Question images in content: ${content.images ? content.images.length : 0}`);

        // Call Cerebras API
        debugLog('ASK-AI', 'Calling Cerebras API (qwen-3-32b)...');

        const cerebrasUrl = 'https://api.cerebras.ai/v1/chat/completions';

        // Build the prompt
        let systemPrompt = `You are an expert tutor helping a student solve a quiz question.
Rules:
- Carefully read the entire question and all answer choices.
- Think step by step and explain your reasoning clearly.
- You MUST select your final answer strictly from the given choices. Do not invent new answers.
- If the question is open-ended with no choices, give the exact final answer.
- If it's multiple-choice with single answer → choose one.
- If it explicitly says "select all that apply" or has checkboxes → select all correct ones.
- If there are multiple answers list them, numbered in the order they appear in the question.

Format your response EXACTLY like this and nothing else after the reasoning:

===RESULT===
[Put the final answer(s) here, exactly as they appear in the question text]

Examples of correct RESULT formatting:
===RESULT===
C

===RESULT===
1.8

===RESULT===
1. A
2. D

===RESULT===
1. True
2. False
3. True

===RESULT===
1. papel
2. lapiz
3. pan

===RESULT===
42

Do not add explanations after ===RESULT===. Do not say "So the answer is" or "Therefore". The section after ===RESULT=== must contain ONLY the answer(s) in the exact format shown above.`;

        // Build user prompt with question number if available
        let questionLabel = content.questionNumber ? `Question ${content.questionNumber}` : 'Question';
        let userPrompt = `Here is ${questionLabel}:\n\n${content.text}\n\n`;

        // Combine quiz and question context into a single additional context section
        const combinedContext = [quizContext, questionContext].filter(c => c && c.trim()).join('\n\n');
        if (combinedContext) {
            userPrompt += `ADDITIONAL CONTEXT:\n${combinedContext}\n\n`;
        }

        const requestBody = {
            model: "gpt-oss-120b",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.2,
            max_completion_tokens: 8192,
            top_p: 1,
            reasoning_effort: "high"
        };

        // Log the prompts for debugging
        debugLog('ASK-AI', `--- SYSTEM PROMPT ---\n${systemPrompt}`);
        debugLog('ASK-AI', `--- USER PROMPT ---\n${userPrompt}`);

        const response = await fetch(cerebrasUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        const responseData = await response.json();

        if (!response.ok) {
            debugLog('ASK-AI', `✗ API Error: ${JSON.stringify(responseData)}`);
            return res.json({
                success: false,
                error: responseData.error?.message || 'Cerebras API error'
            });
        }

        // Extract the text response
        const aiResponse = responseData.choices?.[0]?.message?.content;

        if (!aiResponse) {
            debugLog('ASK-AI', '✗ No response from AI');
            return res.json({
                success: false,
                error: 'No response from AI.'
            });
        }

        debugLog('ASK-AI', `✓ Got AI response (${aiResponse.length} chars)`);

        // Parse the result section
        let parsedAnswers = [];
        if (aiResponse.includes('===RESULT===')) {
            const resultSection = aiResponse.split('===RESULT===')[1].trim();
            const lines = resultSection.split('\n').filter(line => line.trim());

            if (lines.length === 1 && !lines[0].match(/^\d+\./)) {
                // Single answer
                parsedAnswers = [lines[0].trim()];
            } else {
                // Multiple answers - parse numbered list
                parsedAnswers = lines.map(line => {
                    // Remove leading number and dot (e.g., "1. answer" -> "answer")
                    return line.replace(/^\d+\.\s*/, '').trim();
                });
            }
        }

        debugLog('ASK-AI', `Parsed ${parsedAnswers.length} answers: ${JSON.stringify(parsedAnswers)}`);

        res.json({
            success: true,
            response: aiResponse,
            parsedAnswers: parsedAnswers
        });

    } catch (error) {
        debugLog('ASK-AI', `✗ ERROR: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Enter the AI answers into the Schoology quiz page
app.post('/api/quiz/enter-answers', requireBrowserFeatures, express.json(), async (req, res) => {
    debugLog('ENTER-ANSWERS', '=== Entering answers on quiz page ===');

    const { answers } = req.body;


    if (!answers || !Array.isArray(answers) || answers.length === 0) {
        return res.json({
            success: false,
            error: 'No answers provided'
        });
    }

    // Attempt Rehydration
    const { quizUrl } = req.body;
    try {
        await rehydrateQuizPage(quizUrl, req.cookies?.schoology_sess);
    } catch (e) {
        debugLog('VERCEL', `Rehydration failed: ${e.message}`);
    }

    if (!quizPage) {
        return res.json({
            success: false,
            error: 'No active quiz page'
        });
    }

    try {
        debugLog('ENTER-ANSWERS', `Attempting to enter ${answers.length} answer(s): ${JSON.stringify(answers)}`);

        // Wait for inputs to be available
        try {
            debugLog('ENTER-ANSWERS', 'Waiting for interactive elements...');
            await quizPage.waitForSelector('input[type="text"], textarea, .lrn_btn_drag, select', { state: 'visible', timeout: 10000 });
        } catch (e) {
            debugLog('ENTER-ANSWERS', '⚠️ Timeout waiting for inputs, trying to proceed...');
        }

        const log = [];
        let answered = false;

        const visibleElements = await quizPage.evaluate(() => {
            // Standardized robust visibility check
            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            };

            // Find the active container
            let container = null;
            const activeSelectors = [
                '.question-view.active',
                '.slide.active',
                '.question-container.current',
                '.question-body:not([style*="display: none"])'
            ];
            for (const s of activeSelectors) {
                const el = document.querySelector(s);
                if (el && isVisible(el)) {
                    container = el;
                    break;
                }
            }
            if (!container) container = document.body;

            // Get only VISIBLE drag buttons and drop zones
            const allDrags = container.querySelectorAll('.lrn_btn_drag');
            const allDrops = container.querySelectorAll('.lrn_dropzone');

            const visibleDrags = Array.from(allDrags).filter(isVisible);
            const visibleDrops = Array.from(allDrops).filter(isVisible);

            // Mark visible elements for Playwright to find
            visibleDrags.forEach((el, i) => el.setAttribute('data-visible-drag', i.toString()));
            visibleDrops.forEach((el, i) => el.setAttribute('data-visible-drop', i.toString()));

            // Identify empty drop zones to avoid overwriting (simple heuristic: no text or check for specific classes)
            const emptyIndices = [];
            visibleDrops.forEach((el, i) => {
                // Check if it has a drag item inside or significant text
                const hasItem = el.querySelector('.lrn_btn_drag') !== null;
                const hasText = el.textContent.trim().length > 0;

                // If it doesn't have a drag item and text is empty (or very short, allowing for nbsp), consider it empty
                if (!hasItem && (!hasText || el.textContent.trim() === '')) {
                    emptyIndices.push(i);
                }
            });

            return {
                totalDrags: allDrags.length,
                visibleDrags: visibleDrags.length,
                visibleDragTexts: visibleDrags.map(el => el.textContent.trim()),
                totalDrops: allDrops.length,
                visibleDrops: visibleDrops.length,
                emptyDropIndices: emptyIndices, // Return indices of empty zones

                // Also check for other input types - using precise visibility check
                radios: Array.from(container.querySelectorAll('input[type="radio"]')).filter(isVisible).length,
                checkboxes: Array.from(container.querySelectorAll('input[type="checkbox"]')).filter(isVisible).length,
                textInputs: Array.from(container.querySelectorAll('input[type="text"], textarea')).filter(isVisible).length,
                selects: Array.from(container.querySelectorAll('select')).filter(isVisible).length,
            };
        });

        debugLog('ENTER-ANSWERS', `VISIBLE ELEMENTS: ${JSON.stringify(visibleElements, null, 2)}`);
        log.push(`Total drags: ${visibleElements.totalDrags}, Visible: ${visibleElements.visibleDrags}`);
        log.push(`Total drops: ${visibleElements.totalDrops}, Visible: ${visibleElements.visibleDrops}`);
        log.push(`Empty drop zones indices: ${visibleElements.emptyDropIndices.join(', ')}`);

        // Use visible elements for pageDebug compatibility
        const pageDebug = {
            lrnDragBtns: visibleElements.visibleDrags,
            lrnDragBtnTexts: visibleElements.visibleDragTexts,
            responseAreas: visibleElements.visibleDrops,
            radios: visibleElements.radios,
            checkboxes: visibleElements.checkboxes,
            textInputs: visibleElements.textInputs,
            selects: visibleElements.selects,
        };

        // CASE: Learnosity drag and drop (visible elements only)
        if (visibleElements.visibleDrags > 0 && visibleElements.visibleDrops > 0) {
            log.push(`Found visible drag/drop: ${visibleElements.visibleDrags} drags, ${visibleElements.visibleDrops} drops`);
            debugLog('ENTER-ANSWERS', `Attempting drag/drop with VISIBLE elements only...`);

            // Track which answers have been used
            const usedAnswers = new Set();
            const usedDragIndices = new Set();

            // Get ONLY visible drag buttons (marked with data-visible-drag)
            const dragButtons = await quizPage.$$('[data-visible-drag]');
            const dropZones = await quizPage.$$('[data-visible-drop]');

            debugLog('ENTER-ANSWERS', `Found ${dragButtons.length} visible drags, ${dropZones.length} visible drops`);

            // Build list of drag buttons with their text
            const dragButtonsInfo = [];
            for (let i = 0; i < dragButtons.length; i++) {
                const btn = dragButtons[i];
                const text = await btn.textContent();
                dragButtonsInfo.push({
                    element: btn,
                    index: i,
                    text: text.trim(),
                    textNorm: text.trim().toLowerCase().replace(/[^\w\s]/g, '')
                });
            }

            debugLog('ENTER-ANSWERS', `Visible drag options: ${dragButtonsInfo.map(d => d.text).join(', ')}`);
            log.push(`Visible drags: ${dragButtonsInfo.map(d => d.text).join(', ')}`);

            // Use logic to fill ONLY empty drop zones if possible
            // If we have identification of empty zones, prefer them.
            // But fallback to filling sequentially if we run out.
            let targetIndices = visibleElements.emptyDropIndices;

            // If no empty indices found (maybe heuristic failed?), or user wants overwrite, we might need fallback.
            // But user specifically asked to "fill empty drop zones".
            if (targetIndices.length === 0 && visibleElements.visibleDrops > 0 && answers.length > 0) {
                log.push('Note: No empty drop zones detected. Checking all zones.');
                // Fallback: Use all zones if we think none are empty but we have answers?
                // Or maybe the user *has* filled everything and wants to overwrite?
                // The prompt implies "when some are filled", implying we should respect them.
                // So if targetIndices is empty, maybe we stop?
                // Let's trust the detection. If 0 empty, we do nothing for drag-drop.
            }

            // For each AI answer, find a matching drag and enter into the next EMPTY drop zone
            let answerIdx = 0;
            for (let i = 0; i < targetIndices.length; i++) {
                if (answerIdx >= answers.length) break; // No more answers to input

                const dropIdx = targetIndices[i]; // The actual index of the drop zone to use
                const answer = answers[answerIdx];
                answerIdx++;

                const ansNorm = answer.trim().toLowerCase().replace(/[^\w\s]/g, '');
                debugLog('ENTER-ANSWERS', `\n--- Looking for drag matching AI answer: "${answer}" ---`);

                // Find a drag that matches this AI answer
                let matchedDrag = null;
                for (const dragInfo of dragButtonsInfo) {
                    if (usedDragIndices.has(dragInfo.index)) continue; // Skip used drags

                    const isMatch = dragInfo.textNorm === ansNorm ||
                        dragInfo.textNorm.includes(ansNorm) ||
                        ansNorm.includes(dragInfo.textNorm);

                    if (isMatch) {
                        matchedDrag = dragInfo;
                        debugLog('ENTER-ANSWERS', `✓ Found matching drag: "${dragInfo.text}"`);
                        break;
                    }
                }

                if (!matchedDrag) {
                    log.push(`AI answer "${answer}" - no matching drag found, SKIPPING`);
                    debugLog('ENTER-ANSWERS', `No drag matches "${answer}", skipping this answer`);
                    continue;
                }

                // Mark as used
                usedDragIndices.add(matchedDrag.index);

                try {
                    // Get the current drop zone using the EMPTY index
                    const dropZone = dropZones[dropIdx];

                    // Scroll and get fresh positions
                    await matchedDrag.element.scrollIntoViewIfNeeded();
                    await quizPage.waitForTimeout(150);
                    const dragBox = await matchedDrag.element.boundingBox();

                    await dropZone.scrollIntoViewIfNeeded();
                    await quizPage.waitForTimeout(150);
                    const dropBox = await dropZone.boundingBox();

                    // debugLog('ENTER-ANSWERS', `Drag box: ${JSON.stringify(dragBox)}`);
                    // debugLog('ENTER-ANSWERS', `Drop box: ${JSON.stringify(dropBox)}`);

                    if (dragBox && dropBox) {
                        const startX = dragBox.x + dragBox.width / 2;
                        const startY = dragBox.y + dragBox.height / 2;
                        const endX = dropBox.x + dropBox.width / 2;
                        const endY = dropBox.y + dropBox.height / 2;

                        log.push(`Dragging "${matchedDrag.text}" to drop zone ${dropIdx + 1} (Empty Slot)`);
                        debugLog('ENTER-ANSWERS', `Drag: (${startX.toFixed(0)}, ${startY.toFixed(0)}) -> (${endX.toFixed(0)}, ${endY.toFixed(0)})`);

                        // Perform the drag
                        await quizPage.mouse.move(startX, startY);
                        await quizPage.waitForTimeout(100);
                        await quizPage.mouse.down();
                        await quizPage.waitForTimeout(150);
                        await quizPage.mouse.move(endX, endY, { steps: 25 });
                        await quizPage.waitForTimeout(150);
                        await quizPage.mouse.up();
                        await quizPage.waitForTimeout(400);

                        log.push(`✓ Dragged "${matchedDrag.text}" to zone ${dropIdx + 1}`);
                        answered = true;

                    } else {
                        log.push(`⚠ Could not get bounding box`);
                    }
                } catch (err) {
                    log.push(`⚠ Error: ${err.message}`);
                    debugLog('ENTER-ANSWERS', `Error: ${err.message}`);
                }
            }

            log.push(`Completed: ${usedDragIndices.size} AI answers placed into ${dropIdx} zones`);

            // Clean up the marker attributes
            await quizPage.evaluate(() => {
                document.querySelectorAll('[data-visible-drag]').forEach(el => el.removeAttribute('data-visible-drag'));
                document.querySelectorAll('[data-visible-drop]').forEach(el => el.removeAttribute('data-visible-drop'));
            });
        }

        // CASE: Standard radio buttons (single choice) - only if drag/drop didn't work
        if (pageDebug.radios > 0 && answers.length === 1 && !answered) {
            const answer = answers[0];
            log.push(`Trying radio buttons for answer: "${answer}"`);

            const clicked = await quizPage.evaluate((ans) => {
                // Robust visibility check
                const isVisible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                };

                // Find active container
                let container = null;
                const activeSelectors = [
                    '.question-view.active',
                    '.slide.active',
                    '.question-container.current',
                    '.question-body:not([style*="display: none"])'
                ];
                for (const s of activeSelectors) {
                    const el = document.querySelector(s);
                    if (el && isVisible(el)) {
                        container = el;
                        break;
                    }
                }
                if (!container) container = document.body;

                const radios = container.querySelectorAll('input[type="radio"]');
                const ansNorm = ans.trim().toLowerCase().replace(/[^\w\s]/g, '');

                for (const radio of radios) {
                    const label = radio.closest('label') || document.querySelector(`label[for="${radio.id}"]`);
                    const parent = radio.closest('.choice, .answer-choice, .option, li, div');
                    const text = (label?.textContent || parent?.textContent || '').trim();
                    const textNorm = text.toLowerCase().replace(/[^\w\s]/g, '');

                    const letterMatch = /^[a-d]$/i.test(ans) && text.toLowerCase().startsWith(ans.toLowerCase());
                    const contentMatch = textNorm.includes(ansNorm) || ansNorm.includes(textNorm);

                    if (letterMatch || contentMatch) {
                        radio.click();
                        return text.substring(0, 50);
                    }
                }
                return null;
            }, answer);

            if (clicked) {
                log.push(`✓ Clicked radio: "${clicked}..."`);
                answered = true;
            }
        }

        // CASE: Checkboxes (multiple choice)
        if (pageDebug.checkboxes > 0 && !answered) {
            log.push(`Trying checkboxes for ${answers.length} answer(s)`);

            for (const answer of answers) {
                const clicked = await quizPage.evaluate((ans) => {
                    // Robust visibility check
                    const isVisible = (el) => {
                        if (!el) return false;
                        const style = window.getComputedStyle(el);
                        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                    };

                    // Find active container
                    let container = null;
                    const activeSelectors = [
                        '.question-view.active',
                        '.slide.active',
                        '.question-container.current',
                        '.question-body:not([style*="display: none"])'
                    ];
                    for (const s of activeSelectors) {
                        const el = document.querySelector(s);
                        if (el && isVisible(el)) {
                            container = el;
                            break;
                        }
                    }
                    if (!container) container = document.body;

                    const checkboxes = container.querySelectorAll('input[type="checkbox"]:not([id*="nav"])');
                    const ansNorm = ans.trim().toLowerCase().replace(/[^\w\s]/g, '');

                    for (const cb of checkboxes) {
                        const label = cb.closest('label') || document.querySelector(`label[for="${cb.id}"]`);
                        const parent = cb.closest('.choice, .answer-choice, .option, li, div');
                        const text = (label?.textContent || parent?.textContent || '').trim();
                        const textNorm = text.toLowerCase().replace(/[^\w\s]/g, '');

                        const letterMatch = /^[a-d]$/i.test(ans) && text.toLowerCase().startsWith(ans.toLowerCase());
                        const contentMatch = textNorm.includes(ansNorm) || ansNorm.includes(textNorm);

                        if ((letterMatch || contentMatch) && !cb.checked) {
                            cb.click();
                            return text.substring(0, 50);
                        }
                    }
                    return null;
                }, answer);

                if (clicked) {
                    log.push(`✓ Checked: "${clicked}..."`);
                    answered = true;
                }
            }
        }

        // CASE: Text inputs (fill in the blank)
        if (pageDebug.textInputs > 0 && !answered) {
            log.push(`Trying text inputs (${pageDebug.textInputs} fields)`);

            // We need to type into inputs using Puppeteer for reliability
            // First, find the elements we need to type into
            const inputsToFill = await quizPage.evaluate((answersArr) => {
                // Robust visibility check
                const isVisible = (el) => {
                    if (!el) return false;

                    // Use native checkVisibility if available
                    if (el.checkVisibility) {
                        return el.checkVisibility({
                            checkOpacity: true,
                            checkVisibilityCSS: true
                        });
                    }

                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                };

                // Find active container
                let container = null;
                const activeSelectors = [
                    '.question-view.active',
                    '.slide.active',
                    '.question-container.current',
                    '.question-body:not([style*="display: none"])'
                ];
                for (const s of activeSelectors) {
                    const el = document.querySelector(s);
                    if (el && isVisible(el)) {
                        container = el;
                        break;
                    }
                }
                if (!container) container = document.body;

                console.log('Searching for inputs in:', container.className || container.tagName);

                const inputs = Array.from(container.querySelectorAll('input[type="text"]:not([readonly]), textarea'))
                    .filter(input => {
                        return isVisible(input) && !input.disabled;
                    });

                console.log(`Found ${inputs.length} visible text inputs.`);

                // Mark the inputs we want to fill
                const indices = [];
                for (let i = 0; i < Math.min(inputs.length, answersArr.length); i++) {
                    const input = inputs[i];
                    input.setAttribute('data-ai-fill-target', i.toString());
                    indices.push(i);
                }
                return indices;
            }, answers);

            if (inputsToFill.length > 0) {
                for (let i = 0; i < inputsToFill.length; i++) {
                    const idx = inputsToFill[i];
                    const answer = answers[idx];

                    try {
                        debugLog('ENTER-ANSWERS', `Processing input ${i + 1}/${inputsToFill.length} (Index: ${idx})`);
                        const inputHandle = await quizPage.$(`[data-ai-fill-target="${idx}"]`);

                        if (inputHandle) {
                            // Guarded Click
                            debugLog('ENTER-ANSWERS', `Clicking input ${idx}...`);
                            try {
                                await withTimeout(
                                    inputHandle.click({ clickCount: 3 }),
                                    1000,
                                    'timeout'
                                );
                            } catch (e) {
                                debugLog('ENTER-ANSWERS', `Click warning: ${e.message}`);
                            }

                            // Guarded Clear
                            debugLog('ENTER-ANSWERS', `Clearing input ${idx}...`);
                            await inputHandle.press('Backspace');

                            // Guarded Type
                            debugLog('ENTER-ANSWERS', `Typing "${answer.substring(0, 10)}..." into input ${idx}...`);
                            await withTimeout(
                                inputHandle.type(answer, { delay: 10 }), // Faster typing
                                2000,
                                'timeout'
                            );

                            // Trigger extra events just in case
                            await quizPage.evaluate((el) => {
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                el.blur();
                            }, inputHandle);

                            log.push(`✓ Typed into field ${idx + 1}: "${answer}"`);
                            debugLog('ENTER-ANSWERS', `✓ Done with input ${idx}`);
                        } else {
                            debugLog('ENTER-ANSWERS', `⚠ Handle lost for input ${idx}`);
                        }
                    } catch (e) {
                        debugLog('ENTER-ANSWERS', `⚠ Error typing answer ${idx + 1}: ${e.message}`);
                        log.push(`⚠ Error typing answer ${idx + 1}: ${e.message}`);
                    }
                }

                // Cleanup
                await quizPage.evaluate(() => {
                    document.querySelectorAll('[data-ai-fill-target]').forEach(el => el.removeAttribute('data-ai-fill-target'));
                });
                answered = true;
            }
        }

        // CASE: Dropdown selects
        if (pageDebug.selects > 0 && !answered) {
            log.push(`Trying dropdown selects`);

            const selected = await quizPage.evaluate((answersArr) => {
                const isVisible = (el) => {
                    if (!el) return false;
                    // Use native checkVisibility if available
                    if (el.checkVisibility) {
                        return el.checkVisibility({
                            checkOpacity: true,
                            checkVisibilityCSS: true
                        });
                    }
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                };

                // Find active container
                let container = null;
                const activeSelectors = [
                    '.question-view.active',
                    '.slide.active',
                    '.question-container.current',
                    '.question-body:not([style*="display: none"])'
                ];
                for (const s of activeSelectors) {
                    const el = document.querySelector(s);
                    if (el && isVisible(el)) {
                        container = el;
                        break;
                    }
                }
                if (!container) container = document.body;

                const selects = Array.from(container.querySelectorAll('select'))
                    .filter(sel => isVisible(sel) && !sel.disabled);

                const results = [];
                for (let i = 0; i < Math.min(selects.length, answersArr.length); i++) {
                    const select = selects[i];
                    const ansNorm = answersArr[i].trim().toLowerCase().replace(/[^\w\s]/g, '');

                    for (const option of select.options) {
                        const optNorm = option.text.toLowerCase().replace(/[^\w\s]/g, '');
                        if (optNorm.includes(ansNorm) || ansNorm.includes(optNorm)) {
                            select.value = option.value;
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                            results.push(option.text);
                            break;
                        }
                    }
                }
                return results;
            }, answers);

            if (selected.length > 0) {
                selected.forEach(opt => log.push(`✓ Selected: "${opt}"`));
                answered = true;
            }
        }

        if (!answered) {
            log.push('⚠ Could not find matching input elements for the answer');
        }

        debugLog('ENTER-ANSWERS', `Final log: ${JSON.stringify(log)}`);

        // Take a new screenshot to show the result
        await quizPage.waitForTimeout(2000);
        const screenshot = await takeQuizScreenshot(quizPage);
        const screenshotBase64 = screenshot.toString('base64');

        // Extract the updated content immediately to ensure sync
        const updatedContent = await extractQuizContent(quizPage);

        res.json({
            success: answered,
            log: log,
            screenshot: screenshotBase64,
            html: updatedContent.html, // Send updated HTML
            text: updatedContent.text, // Send updated Text
            message: answered ? 'Answers entered successfully' : 'Could not enter answers automatically'
        });

    } catch (error) {
        debugLog('ENTER-ANSWERS', `✗ ERROR: ${error.message}`);
        debugLog('ENTER-ANSWERS', `Stack: ${error.stack}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Helper function to take screenshot of slides-container only
async function takeQuizScreenshot(page) {
    // Try to find the slides-container element
    const slidesContainer = await page.$('.slides-container');

    if (slidesContainer) {
        debugLog('SCREENSHOT', '✓ Found .slides-container, taking element screenshot');
        return await slidesContainer.screenshot({ type: 'png' });
    }

    // Fallback: try other common quiz content containers
    const fallbackSelectors = ['.assessment-content', '.quiz-content', '.question-container', 'main'];
    for (const selector of fallbackSelectors) {
        const el = await page.$(selector);
        if (el) {
            debugLog('SCREENSHOT', `✓ Found ${selector}, taking element screenshot`);
            return await el.screenshot({ type: 'png' });
        }
    }

    // Last resort: full page screenshot
    debugLog('SCREENSHOT', '✗ No container found, taking full viewport screenshot');
    return await page.screenshot({ type: 'png', fullPage: false });
}

// Helper function to extract quiz content (HTML + images)
async function extractQuizContent(page) {
    debugLog('EXTRACT', 'Extracting quiz content...');

    try {
        // Wait for loading to finish (shorter timeout)
        debugLog('EXTRACT', 'Waiting for loading indicators to disappear...');
        try {
            await page.waitForFunction(() => {
                const text = document.body.innerText;
                return !text.includes('Loading question') && !text.includes('Just a moment please');
            }, { timeout: 2000 }); // Reduced to 2s
        } catch (e) {
            debugLog('EXTRACT', 'Timeout waiting for loading text to disappear, proceeding anyway...');
        }

        // Wait for question content (shorter timeout)
        debugLog('EXTRACT', 'Waiting for question content...');
        try {
            await page.waitForSelector('.question-body, .question-text, .multiple-choice-question, .ordering-question, .matching-question', { timeout: 2000 }); // Reduced to 2s
        } catch (e) {
            debugLog('EXTRACT', 'Timeout waiting for specific question selector, trying generic containers...');
        }

        const content = await page.evaluate(async () => {
            // Helper to check visibility (Performance Optimized)
            const isVisible = (el) => {
                if (!el) return false;

                // Use native checkVisibility if available (Chrome 105+), extremely fast
                if (el.checkVisibility) {
                    return el.checkVisibility({
                        checkOpacity: true,
                        checkVisibilityCSS: true
                    });
                }

                // Fallback for older browsers (Expensive!)
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            };

            // Find the container
            let container = null;

            // 1. Try specific ACTIVE question selectors
            const activeSelectors = [
                '.question-view.active',
                '.slide.active',
                '.question-container.current',
                '.question-body:not([style*="display: none"])'
            ];

            for (const s of activeSelectors) {
                const el = document.querySelector(s);
                if (el && isVisible(el)) {
                    container = el;
                    break;
                }
            }

            // 2. If no specific active class, look for generic question containers and pick the visible one
            if (!container) {
                const genericSelectors = ['.question-view', '.question-body', '.slides-container .slide', '.assessment-content > div'];
                for (const s of genericSelectors) {
                    const elements = document.querySelectorAll(s);
                    for (const el of elements) {
                        if (isVisible(el)) {
                            container = el;
                            break;
                        }
                    }
                    if (container) break;
                }
            }

            // 3. Fallback to main containers if they are visible
            if (!container) {
                const fallbackSelectors = ['.slides-container', '.assessment-content', '.quiz-content', 'main'];
                for (const s of fallbackSelectors) {
                    const el = document.querySelector(s);
                    if (el && isVisible(el)) {
                        // If we found a broad container like .slides-container, try to find the visible child inside it
                        if (s === '.slides-container' || s === '.assessment-content') {
                            const children = Array.from(el.children);
                            const visibleChild = children.find(child => isVisible(child));
                            if (visibleChild) {
                                container = visibleChild;
                                break;
                            }
                        }
                        container = el;
                        break;
                    }
                }
            }

            if (!container) return { html: '<div class="error-content">Could not find quiz content container.</div>', text: '' };

            // Function to clone only visible elements
            function cloneVisible(node) {
                if (node.nodeType === Node.TEXT_NODE) {
                    return node.cloneNode(true);
                }
                if (node.nodeType === Node.ELEMENT_NODE) {
                    // Use optimized isVisible check
                    if (!isVisible(node)) return null;

                    // Skip script/style tags
                    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME'].includes(node.tagName)) {
                        return null;
                    }

                    // Skip junk selectors
                    if (node.matches && (
                        node.matches('.skip-link') ||
                        node.matches('.visually-hidden') ||
                        node.matches('.sr-only') ||
                        node.matches('.loading-overlay') ||
                        node.matches('.loader') ||
                        node.matches('.lrn_accessibility_label') ||
                        node.matches('a[href^="#"]')
                    )) {
                        return null;
                    }

                    const clonedNode = node.cloneNode(false); // Shallow clone

                    // sync value/checked properties to attributes for inputs
                    if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') {
                        if (node.type === 'checkbox' || node.type === 'radio') {
                            if (node.checked) {
                                clonedNode.setAttribute('checked', 'checked');
                            } else {
                                clonedNode.removeAttribute('checked');
                            }
                        } else if (node.tagName === 'TEXTAREA') {
                            clonedNode.textContent = node.value;
                        } else if (node.tagName === 'SELECT') {
                            // For select, we need to mark the selected option
                            // We'll handle children later, but we can't easily sync select value without children
                            // So we defer this to the child loop or just handle it here if we were cloning deep
                        } else {
                            // Text input, etc.
                            clonedNode.setAttribute('value', node.value);
                        }
                    }

                    for (const child of node.childNodes) {
                        const clonedChild = cloneVisible(child);
                        if (clonedChild) {
                            // If parent is select and child is option, check if selected
                            if (node.tagName === 'SELECT' && child.tagName === 'OPTION') {
                                if (child.selected) {
                                    clonedChild.setAttribute('selected', 'selected');
                                }
                            }
                            clonedNode.appendChild(clonedChild);
                        }
                    }
                    return clonedNode;
                }
                return node.cloneNode(true);
            }

            // Create a clean clone with only visible elements
            const clone = cloneVisible(container);

            if (!clone) return { html: '<div class="error-content">Content is hidden.</div>', text: '' };

            // Remove elements containing "Loading question" text
            const allElements = clone.querySelectorAll('*');
            allElements.forEach(el => {
                if (el.innerText && (el.innerText.includes('Loading question') || el.innerText.includes('Skip to navigation'))) {
                    // Only remove if it's a leaf node or small container, not the whole thing
                    if (el.children.length === 0 || el.tagName === 'SPAN' || el.tagName === 'DIV') {
                        el.remove();
                    }
                }
            });

            // Process images to base64
            const images = clone.querySelectorAll('img');
            for (const img of images) {
                try {
                    const src = img.src;
                    if (src && !src.startsWith('data:')) {
                        // Fetch the image data
                        const response = await fetch(src);
                        const blob = await response.blob();

                        // Convert to base64
                        await new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onloadend = () => {
                                img.src = reader.result;
                                resolve();
                            };
                            reader.readAsDataURL(blob);
                        });
                    }
                } catch (e) {
                    console.error('Failed to process image:', e);
                }
            }

            // Get text content ONLY from visible nodes in the original container
            // We can't trust clone.innerText because the clone is detached and has no layout info.
            // So we traverse the ORIGINAL container to get text.

            function getVisibleText(node) {
                if (node.nodeType === Node.TEXT_NODE) {
                    return node.textContent;
                }
                if (node.nodeType === Node.ELEMENT_NODE) {
                    const style = window.getComputedStyle(node);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                        return '';
                    }
                    // Skip script/style tags
                    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME'].includes(node.tagName)) {
                        return '';
                    }

                    // Skip "Skip to navigation" links
                    if (node.classList.contains('skip-link') ||
                        node.textContent.includes('Skip to navigation') ||
                        node.getAttribute('aria-label') === 'Skip to navigation') {
                        // Double check if it's the specific link, not a container
                        if (node.tagName === 'A' || node.tagName === 'SPAN' || node.children.length === 0) {
                            return '';
                        }
                    }

                    // Special handling for Drag Buttons
                    if (node.classList.contains('lrn_btn_drag')) {
                        let btnText = '';
                        for (const child of node.childNodes) {
                            btnText += getVisibleText(child);
                        }
                        return ' [Answer Choice: ' + btnText.trim() + '] ';
                    }

                    let text = '';
                    for (const child of node.childNodes) {
                        text += getVisibleText(child);
                    }

                    // Add block spacing
                    if (style.display === 'block' || style.display === 'flex' || style.display === 'grid') {
                        text = '\n' + text + '\n';
                    }
                    return text;
                }
                return '';
            }

            let visibleText = getVisibleText(container).replace(/\n\s*\n/g, '\n').trim();

            // Refined cleaning
            visibleText = visibleText.replace(/Skip to navigation/gi, ''); // Fallback cleanup
            visibleText = visibleText.replace(/(?:Possible[\s\n]*Points|Points[\s\n]*Possible)[\s\n]*:?[\s\n]*[\d.,]+/gi, '');
            // Also catch standalone "Possible Points" text without numbers (header labels)
            visibleText = visibleText.replace(/(?:Possible[\s\n]*Points|Points[\s\n]*Possible)[\s\n]*:?\s*$/gim, '');

            // Extract question number from pagination (this is on the full page, not in the question container)
            let questionNumber = null;
            const pageActive = document.querySelector('.lrn-assess-li.pagination-active');
            if (pageActive) {
                // Try to find the number in text nodes
                const walker = document.createTreeWalker(pageActive, NodeFilter.SHOW_TEXT, null);
                let node;
                while ((node = walker.nextNode())) {
                    const txt = node.textContent.trim();
                    if (txt && /^\d+$/.test(txt)) {
                        questionNumber = parseInt(txt, 10);
                        break;
                    }
                }
                // Fallback: try textContent
                if (!questionNumber) {
                    const txt = pageActive.textContent.trim();
                    const match = txt.match(/(\d+)/);
                    if (match) questionNumber = parseInt(match[1], 10);
                }
            }

            // Collect base64 images for AI
            const imageDataList = [];
            const imagesForAI = clone.querySelectorAll('img');
            for (const img of imagesForAI) {
                if (img.src && img.src.startsWith('data:')) {
                    imageDataList.push(img.src);
                }
            }

            return {
                html: clone.innerHTML,
                text: visibleText,
                questionNumber: questionNumber,
                images: imageDataList
            };
        });

        debugLog('EXTRACT', `✓ Extracted content (${content.html.length} chars)`);
        return content;
    } catch (e) {
        debugLog('EXTRACT', `✗ Failed to extract content: ${e.message}`);
        return { html: `<div class="error-content">Failed to extract content: ${e.message}</div>`, text: '' };
    }
}

// Helper function to check navigation button states
async function checkNavButtons(page) {
    return await page.evaluate(() => {
        const result = {
            canGoBack: false,
            canGoNext: false,
            isReview: false
        };

        // Look for the navigation buttons - Schoology uses input[type="button"] typically
        const allInputs = document.querySelectorAll('input[type="button"], input[type="submit"], button');

        allInputs.forEach(el => {
            const value = (el.value || el.textContent || '').trim().toLowerCase();

            // Check for Previous/Back
            if (value === 'previous' || value === 'back' || value.includes('previous') || value.includes('back')) {
                if (!el.disabled) {
                    result.canGoBack = true;
                }
            }

            // Check for Next vs Review
            if (value === 'next' || value.includes('next')) {
                if (!el.disabled) {
                    result.canGoNext = true;
                }
            }

            // If the button says "Review", we're on the last question
            if (value === 'review' || value.includes('review')) {
                result.isReview = true;
                // When it says Review, there's no "Next" - we're at the end
                result.canGoNext = false;
            }
        });

        return result;
    });
}

// Quiz page - renders the course/assignment selection UI
app.get('/quiz', async (req, res) => {
    debugLog('QUIZ', 'Quiz page requested');

    if (!req.session.accessToken) {
        debugLog('QUIZ', 'No access token, redirecting to home');
        return res.redirect('/');
    }

    // Quiz page now requires section and assignment ID from query params
    const sectionId = req.query.section;
    const assignmentId = req.query.id;
    const courseId = req.query.course;

    if (!sectionId || !assignmentId || !courseId) {
        debugLog('QUIZ', 'Missing required params, redirecting to courses');
        return res.redirect('/courses');
    }

    try {
        // Fetch assignment details
        const assignmentUrl = `${config.apiBase}/sections/${sectionId}/assignments/${assignmentId}`;
        debugLog('QUIZ', `Fetching assignment from: ${assignmentUrl}`);
        const assignment = await makeOAuthRequest('GET', assignmentUrl, req.session.accessToken);
        debugLog('QUIZ', `✓ Got assignment: ${assignment.title}`);

        // Fetch section info for course name
        const sectionUrl = `${config.apiBase}/sections/${sectionId}`;
        debugLog('QUIZ', `Fetching section from: ${sectionUrl}`);
        const section = await makeOAuthRequest('GET', sectionUrl, req.session.accessToken);
        debugLog('QUIZ', `✓ Section: ${section.course_title || section.section_title}`);

        res.render('quiz', {
            assignment,
            section,
            courseId,
            sectionId,
            assignmentId,
            quizUrl: assignment.web_url, // Pass URL for Vercel rehydration
            authenticated: true,
            userName: req.session.userName
        });
    } catch (error) {
        debugLog('QUIZ', `✗ Error fetching quiz data: ${error.message}`);
        res.render('error', { message: 'Failed to load quiz: ' + error.message });
    }
});

// API to get assignments for a specific section (for quiz page)
app.get('/api/quiz/assignments/:sectionId', async (req, res) => {
    debugLog('QUIZ-API', `Fetching assignments for section: ${req.params.sectionId}`);

    if (!req.session.accessToken) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const assignments = await fetchAllAssignments(req.params.sectionId, req.session.accessToken);
        debugLog('QUIZ-API', `✓ Found ${assignments.length} assignments`);
        res.json({ assignments });
    } catch (error) {
        debugLog('QUIZ-API', `✗ Error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Inbox page
app.get('/inbox', async (req, res) => {
    debugLog('INBOX', 'Inbox page requested');

    if (!req.session.accessToken) {
        debugLog('INBOX', 'No access token, redirecting to home');
        return res.redirect('/');
    }

    res.render('inbox', {
        authenticated: true,
        userName: req.session.userName
    });
});

// Focus page - distraction-free assignment view
app.get('/focus', async (req, res) => {
    debugLog('FOCUS', 'Focus page requested');

    if (!req.session.accessToken) {
        debugLog('FOCUS', 'No access token, redirecting to home');
        return res.redirect('/');
    }

    try {
        const startTime = Date.now();

        // ⚡ Use cached sections
        debugLog('FOCUS', '⚡ Fetching sections with caching...');
        const sections = await fetchAllSectionsOptimized(req.session.userId, req.session.accessToken);

        // ⚡ PARALLEL FETCH: Get assignments for all sections
        debugLog('FOCUS', '⚡ Fetching assignments for all sections in parallel...');
        const sectionsToFetch = sections.slice(0, 10); // Limit to first 10

        const assignmentsResults = await fetchAssignmentsForSectionsParallel(
            sectionsToFetch.map(s => s.id),
            req.session.accessToken,
            5
        );

        debugLog('FOCUS', `⚡ All assignments fetched in ${Date.now() - startTime}ms`);

        // Combine all assignments
        let allAssignments = [];
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const threeDaysAgo = new Date(todayStart);
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

        for (const section of sectionsToFetch) {
            const result = assignmentsResults[section.id];
            if (result && result.assignments) {
                for (const assignment of result.assignments) {
                    const hasDue = assignment.due && assignment.due.trim() !== '';
                    if (!hasDue) continue;

                    const dueDate = new Date(assignment.due);

                    if (dueDate >= threeDaysAgo) {
                        assignment.course_name = section.course_title || section.section_title;
                        allAssignments.push(assignment);
                    }
                }
            }
        }

        // Apply adjusted due times from schedule
        loadSchedule(req.session.userId);
        const userSchedule = scheduleCache[req.session.userId] || {};
        const adjustedDueTimes = userSchedule.adjustedDueTimes || {};

        allAssignments.forEach(assignment => {
            const adjusted = adjustedDueTimes[assignment.id];
            if (adjusted) {
                assignment.originalDue = assignment.due;
                assignment.due = adjusted.adjustedDue;
                assignment.dueAdjusted = true;
            }
        });

        // Sort by due date (soonest first)
        allAssignments.sort((a, b) => new Date(a.due) - new Date(b.due));

        // Add time estimates
        const assignmentsWithTime = addTimeEstimates(allAssignments);

        debugLog('FOCUS', `⚡ Total processing time: ${Date.now() - startTime}ms`);
        debugLog('FOCUS', `Found ${allAssignments.length} assignments for focus mode`);

        res.render('focus', {
            assignments: assignmentsWithTime,
            authenticated: true,
            userName: req.session.userName,
            active: 'focus'
        });
    } catch (error) {
        debugLog('FOCUS', `Error: ${error.message}`);
        res.render('error', { message: 'Failed to load focus mode: ' + error.message });
    }
});

// Schedule page
app.get('/schedule', async (req, res) => {
    debugLog('SCHEDULE', 'Schedule page requested');

    if (!req.session.accessToken) {
        debugLog('SCHEDULE', 'No access token, redirecting to home');
        return res.redirect('/');
    }

    try {
        // ⚡ Use cached sections
        const courses = await fetchAllSectionsOptimized(req.session.userId, req.session.accessToken);

        debugLog('SCHEDULE', `Found ${courses.length} courses`);

        res.render('schedule', {
            authenticated: true,
            userName: req.session.userName,
            courses
        });
    } catch (error) {
        debugLog('SCHEDULE', `Error: ${error.message}`);
        res.render('error', { message: 'Failed to load schedule: ' + error.message });
    }
});

// Get saved schedule
app.get('/api/schedule', (req, res) => {
    if (!req.session.userId) {
        return res.json({ schedule: {} });
    }

    const schedule = loadSchedule(req.session.userId);
    res.json({ schedule });
});

// Submit assignment endpoint
app.post('/api/assignment/submit', express.json(), async (req, res) => {
    debugLog('SUBMIT', 'Assignment submission requested');

    if (!req.session.accessToken) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { sectionId, assignmentId, text } = req.body;

    if (!sectionId || !assignmentId || !text) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        // Submit to Schoology using dropbox submissions API
        // POST /sections/{section_id}/submissions/{assignment_id}
        const submissionUrl = `${config.apiBase}/sections/${sectionId}/submissions/${assignmentId}`;
        debugLog('SUBMIT', `Submitting to: ${submissionUrl}`);

        const submissionData = {
            revision: {
                body: text
            }
        };

        const result = await makeOAuthRequest('POST', submissionUrl, req.session.accessToken, submissionData);
        
        debugLog('SUBMIT', '✓ Submission successful');
        
        // Invalidate cache for this assignment's submission and grade
        invalidateCache(`${req.session.userId}:grade-${sectionId}-${assignmentId}`);
        invalidateCache(`${req.session.userId}:assignment-${sectionId}-${assignmentId}`);
        
        res.json({ success: true, submission: result });
    } catch (error) {
        debugLog('SUBMIT', `✗ Submission failed: ${error.message}`);
        res.status(500).json({ error: error.message || 'Submission failed' });
    }
});

// Save schedule and update assignment due times
app.post('/api/schedule/save', express.json(), async (req, res) => {
    debugLog('SCHEDULE', 'Saving schedule');

    if (!req.session.accessToken || !req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const { schedule } = req.body;
        const userId = req.session.userId;

        // Save the schedule
        saveSchedule(userId, schedule);

        // Now update assignment due times based on schedule
        let assignmentsUpdated = 0;

        // Build a map of sectionId -> day -> start time
        const scheduleMap = {};
        Object.keys(schedule).forEach(day => {
            schedule[day].forEach(block => {
                if (!scheduleMap[block.sectionId]) {
                    scheduleMap[block.sectionId] = {};
                }
                scheduleMap[block.sectionId][day] = {
                    hour: block.startHour,
                    minute: block.startMinute
                };
            });
        });

        debugLog('SCHEDULE', `Schedule map: ${JSON.stringify(scheduleMap)}`);

        // For each section in the schedule, fetch assignments and check due dates
        for (const sectionId of Object.keys(scheduleMap)) {
            try {
                // Fetch assignments for this section
                const assignments = await fetchAllAssignments(sectionId, req.session.accessToken);

                for (const assignment of assignments) {
                    // Skip if no due date
                    if (!assignment.due || assignment.due.trim() === '') continue;

                    // Skip if assignment allows dropbox (online submission)
                    if (assignment.allow_dropbox === 1 || assignment.allow_dropbox === '1') {
                        debugLog('SCHEDULE', `  Skipping "${assignment.title}" - online submission allowed`);
                        continue;
                    }

                    // Parse the due date
                    let dueDate = new Date(assignment.due);
                    if (isNaN(dueDate.getTime())) continue;

                    // Check if due date has no time component (date only, e.g., "2025-12-05")
                    // Schoology format: "YYYY-MM-DD" for date only, "YYYY-MM-DD HH:MM:SS" for datetime
                    const hasTimeComponent = assignment.due.includes(':');
                    if (!hasTimeComponent) {
                        // Assume 6 AM if no time is specified
                        dueDate.setHours(6, 0, 0, 0);
                        debugLog('SCHEDULE', `  "${assignment.title}" has no time, assuming 6 AM`);
                    }

                    // Get day of week (0=Sunday, 1=Monday, ..., 5=Friday, 6=Saturday)
                    const jsDay = dueDate.getDay();
                    // Convert to our format (1=Monday, 5=Friday)
                    // Sunday=0 -> skip, Monday=1 -> 1, Tuesday=2 -> 2, etc.
                    if (jsDay === 0 || jsDay === 6) continue; // Skip weekends
                    const scheduleDay = jsDay; // 1-5 for Mon-Fri

                    // Check if this section has a class on this day
                    const classTime = scheduleMap[sectionId][scheduleDay];
                    if (!classTime) continue;

                    // Update the due time to class start time
                    const newDueDate = new Date(dueDate);
                    newDueDate.setHours(classTime.hour, classTime.minute, 0, 0);

                    // Store the adjusted time in our local cache
                    // Note: We don't actually update Schoology's due date (API doesn't allow it for most users)
                    // Instead, we'll store adjusted times locally and use them when displaying
                    if (!scheduleCache[userId].adjustedDueTimes) {
                        scheduleCache[userId].adjustedDueTimes = {};
                    }

                    const originalTime = dueDate.toISOString();
                    const newTime = newDueDate.toISOString();

                    if (originalTime !== newTime) {
                        scheduleCache[userId].adjustedDueTimes[assignment.id] = {
                            originalDue: originalTime,
                            adjustedDue: newTime,
                            sectionId: sectionId,
                            title: assignment.title,
                            hadNoTime: !hasTimeComponent
                        };
                        assignmentsUpdated++;
                        debugLog('SCHEDULE', `  Adjusted "${assignment.title}": ${originalTime} -> ${newTime}`);
                    }
                }
            } catch (e) {
                debugLog('SCHEDULE', `  Error processing section ${sectionId}: ${e.message}`);
            }
        }

        // Save the updated cache with adjusted times
        if (!IS_VERCEL && fs) {
            try {
                fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(scheduleCache, null, 2));
            } catch (e) {
                debugLog('SCHEDULE', `Error persisting schedule cache: ${e.message}`);
            }
        }

        debugLog('SCHEDULE', `Schedule saved. ${assignmentsUpdated} assignments adjusted.`);
        res.json({ success: true, assignmentsUpdated });
    } catch (error) {
        debugLog('SCHEDULE', `Error saving schedule: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API to get adjusted due time for an assignment
app.get('/api/schedule/adjusted-due/:assignmentId', (req, res) => {
    if (!req.session.userId) {
        return res.json({ adjusted: false });
    }

    const schedule = scheduleCache[req.session.userId] || {};
    const adjustedTimes = schedule.adjustedDueTimes || {};
    const adjusted = adjustedTimes[req.params.assignmentId];

    if (adjusted) {
        res.json({ adjusted: true, ...adjusted });
    } else {
        res.json({ adjusted: false });
    }
});

// Get all notifications
app.get('/api/notifications', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userData = loadNotifications(req.session.userId);
    res.json({ notifications: userData.notifications });
});

// Get unread notification count
app.get('/api/notifications/count', (req, res) => {
    if (!req.session.userId) {
        return res.json({ count: 0 });
    }

    const userData = loadNotifications(req.session.userId);
    const unreadCount = userData.notifications.filter(n => !n.read).length;
    res.json({ count: unreadCount });
});

// Mark notification as read
app.post('/api/notifications/read', express.json(), (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { notificationId } = req.body;
    const userData = loadNotifications(req.session.userId);

    const notification = userData.notifications.find(n => n.id === notificationId);
    if (notification) {
        notification.read = true;
        saveNotifications();
    }

    res.json({ success: true });
});

// Mark all notifications as read
app.post('/api/notifications/read-all', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userData = loadNotifications(req.session.userId);
    userData.notifications.forEach(n => n.read = true);
    saveNotifications();

    res.json({ success: true });
});

// Refresh notifications (check for new assignments and grades)
app.post('/api/notifications/refresh', async (req, res) => {
    debugLog('NOTIFICATIONS', 'Refreshing notifications');

    if (!req.session.accessToken || !req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const userId = req.session.userId;
        const userData = loadNotifications(userId);
        let newCount = 0;

        // Fetch user's sections
        const sectionsUrl = `${config.apiBase}/users/${userId}/sections?limit=50`;
        const sectionsData = await makeOAuthRequest('GET', sectionsUrl, req.session.accessToken);
        const sections = sectionsData.section || [];

        debugLog('NOTIFICATIONS', `Checking ${sections.length} sections for new content`);

        // Create section lookup
        const sectionLookup = {};
        sections.forEach(s => {
            sectionLookup[s.id] = s;
        });

        // Check each section for new assignments
        for (const section of sections.slice(0, 10)) { // Limit to first 10 sections for performance
            try {
                // Fetch assignments for this section
                const assignmentsUrl = `${config.apiBase}/sections/${section.id}/assignments?limit=20`;
                const assignmentsData = await makeOAuthRequest('GET', assignmentsUrl, req.session.accessToken);
                const assignments = assignmentsData.assignment || [];

                for (const assignment of assignments) {
                    const assignmentKey = `${section.id}_${assignment.id}`;
                    const lastUpdated = assignment.last_updated ? assignment.last_updated : 0;

                    // Check if this is a new assignment we haven't seen before
                    if (!userData.knownAssignments[assignmentKey]) {
                        userData.knownAssignments[assignmentKey] = {
                            firstSeen: new Date().toISOString(),
                            hasGrade: false,
                            lastUpdated: lastUpdated
                        };

                        // Only notify if assignment was created in last 7 days
                        const createdDate = assignment.created ? new Date(assignment.created * 1000) : new Date();
                        const weekAgo = new Date();
                        weekAgo.setDate(weekAgo.getDate() - 7);

                        if (createdDate > weekAgo) {
                            const added = addNotification(userId, {
                                type: 'new_assignment',
                                title: assignment.title,
                                courseName: section.course_title || section.section_title || 'Unknown Course',
                                courseId: section.course_id || section.id,
                                sectionId: section.id,
                                assignmentId: assignment.id,
                                dueDate: assignment.due ? new Date(assignment.due).toISOString() : null
                            });
                            if (added) newCount++;
                        }
                    } else {
                        // Check if assignment was updated since we last saw it
                        const storedLastUpdated = userData.knownAssignments[assignmentKey].lastUpdated || 0;
                        if (lastUpdated > storedLastUpdated) {
                            userData.knownAssignments[assignmentKey].lastUpdated = lastUpdated;

                            // Only notify if update was recent (within last 3 days)
                            const updateDate = new Date(lastUpdated * 1000);
                            const threeDaysAgo = new Date();
                            threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

                            if (updateDate > threeDaysAgo) {
                                const added = addNotification(userId, {
                                    type: 'updated',
                                    title: assignment.title,
                                    courseName: section.course_title || section.section_title || 'Unknown Course',
                                    courseId: section.course_id || section.id,
                                    sectionId: section.id,
                                    assignmentId: assignment.id,
                                    dueDate: assignment.due ? new Date(assignment.due).toISOString() : null
                                });
                                if (added) newCount++;
                            }
                        }
                    }

                    // Check for new grade
                    if (assignment.grade !== undefined && assignment.grade !== null && assignment.grade !== '') {
                        const gradeKey = `grade_${assignmentKey}`;
                        const hasExistingGrade = userData.knownAssignments[assignmentKey]?.hasGrade;

                        if (!hasExistingGrade) {
                            userData.knownAssignments[assignmentKey].hasGrade = true;

                            const added = addNotification(userId, {
                                type: 'graded',
                                title: assignment.title,
                                courseName: section.course_title || section.section_title || 'Unknown Course',
                                courseId: section.course_id || section.id,
                                sectionId: section.id,
                                assignmentId: assignment.id,
                                grade: assignment.grade,
                                maxPoints: assignment.max_points
                            });
                            if (added) newCount++;
                        }
                    }
                }
            } catch (e) {
                debugLog('NOTIFICATIONS', `Error checking section ${section.id}: ${e.message}`);
            }
        }

        // Also check grades endpoint for grade updates
        try {
            const gradesUrl = `${config.apiBase}/users/${userId}/grades`;
            const gradesData = await makeOAuthRequest('GET', gradesUrl, req.session.accessToken);

            if (gradesData.section) {
                for (const sec of gradesData.section) {
                    if (sec.period && Array.isArray(sec.period)) {
                        for (const period of sec.period) {
                            if (period.assignment && Array.isArray(period.assignment)) {
                                for (const assignment of period.assignment) {
                                    if (assignment.grade !== undefined && assignment.grade !== null && assignment.grade !== '') {
                                        const assignmentKey = `${sec.section_id}_${assignment.assignment_id}`;

                                        if (!userData.knownAssignments[assignmentKey]) {
                                            userData.knownAssignments[assignmentKey] = {
                                                firstSeen: new Date().toISOString(),
                                                hasGrade: true
                                            };
                                        }

                                        const hasExistingGrade = userData.knownAssignments[assignmentKey]?.hasGrade;
                                        if (!hasExistingGrade) {
                                            userData.knownAssignments[assignmentKey].hasGrade = true;

                                            const sectionInfo = sectionLookup[sec.section_id] || {};
                                            const added = addNotification(userId, {
                                                type: 'graded',
                                                title: assignment.assignment_title || 'Assignment',
                                                courseName: sectionInfo.course_title || sectionInfo.section_title || 'Unknown Course',
                                                courseId: sectionInfo.course_id || sec.section_id,
                                                sectionId: sec.section_id,
                                                assignmentId: assignment.assignment_id,
                                                grade: assignment.grade,
                                                maxPoints: assignment.max_points
                                            });
                                            if (added) newCount++;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            debugLog('NOTIFICATIONS', `Error checking grades: ${e.message}`);
        }

        saveNotifications();

        const unreadCount = userData.notifications.filter(n => !n.read).length;
        debugLog('NOTIFICATIONS', `Refresh complete: ${newCount} new notifications, ${unreadCount} unread total`);

        res.json({
            success: true,
            newCount,
            unreadCount,
            notifications: userData.notifications
        });
    } catch (error) {
        debugLog('NOTIFICATIONS', `Error refreshing notifications: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Clear all notifications
app.post('/api/notifications/clear', (req, res) => {
    try {
        const userId = req.session.userId || 'default';
        notificationsCache[userId] = { items: [], lastCheck: new Date().toISOString() };
        saveNotifications();
        debugLog('NOTIFICATIONS', 'All notifications cleared');
        res.json({ success: true });
    } catch (error) {
        debugLog('NOTIFICATIONS', `Error clearing notifications: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Settings page
app.get('/settings', async (req, res) => {
    debugLog('SETTINGS', 'Settings page requested');

    if (!req.session.accessToken) {
        debugLog('SETTINGS', 'No access token, redirecting to home');
        return res.redirect('/');
    }

    try {
        // ⚡ Use cached sections
        const sections = await fetchAllSectionsOptimized(req.session.userId, req.session.accessToken);
        const courses = sections.map(s => ({
            id: s.id,
            name: s.course_title || s.section_title || 'Unknown Course'
        }));

        debugLog('SETTINGS', `Found ${courses.length} enrolled courses`);

        res.render('settings', {
            authenticated: true,
            userName: req.session.userName,
            courses: courses
        });
    } catch (error) {
        debugLog('SETTINGS', `Error fetching courses: ${error.message}`);
        res.render('settings', {
            authenticated: true,
            userName: req.session.userName,
            courses: []
        });
    }
});

// Logout
app.get('/logout', (req, res) => {
    debugLog('LOGOUT', 'User logging out');
    req.session.destroy();
    // Clear authentication cookies
    res.clearCookie('access_token');
    res.clearCookie('user_id');
    res.clearCookie('oauth_request_token');
    res.redirect('/');
});

// Error handler
app.use((err, req, res, next) => {
    debugLog('ERROR', `Unhandled error: ${err.message}`);
    debugLog('ERROR', 'Stack trace:', err.stack);
    res.status(500).render('error', { message: 'Something went wrong!' });
});

app.listen(PORT, () => {
    console.log('');
    console.log('='.repeat(60));
    console.log(`🎓 Schoology Pro Max is running!`);
    console.log('='.repeat(60));

    if (IS_VERCEL) {
        console.log('🌐 Running on Vercel (Serverless Mode)');
        if (BROWSER_FEATURES_ENABLED) {
            console.log('✓ Browser features ENABLED (using @sparticuz/chromium)');
        } else {
            console.log('⚠️  Browser/Quiz features are DISABLED');
            console.log('   (Install @sparticuz/chromium to enable)');
        }
    } else {
        console.log(`📍 Open http://localhost:${PORT} in your browser`);
        if (BROWSER_FEATURES_ENABLED) {
            console.log('✓ Browser features ENABLED (Quiz viewer available)');
        } else {
            console.log('⚠️  Browser features DISABLED');
        }
    }
    console.log('');
    console.log('📋 OAuth Debug Logging is ENABLED');
    console.log('   Watch this terminal for detailed OAuth flow information');
    console.log('');
    if (!config.consumerKey || config.consumerKey === 'your_consumer_key_here') {
        console.log('⚠️  SETUP REQUIRED:');
        console.log('   Create a .env file with:');
        console.log('   SCHOOLOGY_CONSUMER_KEY=your_key');
        console.log('   SCHOOLOGY_CONSUMER_SECRET=your_secret');
        console.log(`   SCHOOLOGY_DOMAIN=${config.domain}`);
    } else {
        console.log('✓ Configuration loaded from .env');
        console.log(`  Domain: ${config.domain}`);
    }
    console.log('='.repeat(60));
    console.log('');
});

// Export the Express app for Vercel serverless
module.exports = app;

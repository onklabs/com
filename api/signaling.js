
// 🚀 PERFORMANCE TOGGLE - Controlled by environment variable
// Set ENABLE_DETAILED_LOGGING=true in Vercel environment variables for detailed logs
// Set ENABLE_DETAILED_LOGGING=false or leave empty for production speed
const ENABLE_DETAILED_LOGGING = false';

// Configuration constants - Controlled by environment variables with fallback defaults
const USER_TIMEOUT =  120000; // 2 minutes for waiting users
const MATCH_LIFETIME =  600000; // 10 minutes for active matches
const MAX_WAITING_USERS = 120000; // Prevent memory bloat

// Timezone scoring constants - Tunable via environment variables
const TIMEZONE_MAX_SCORE = 20; // Maximum points for same timezone
const TIMEZONE_PENALTY =  1; // Points deducted per hour difference
const TIMEZONE_CIRCLE_HOURS = 24; // 24-hour timezone circle (fixed)



let waitingUsers = new Map(); // userId -> { userId, timestamp, userInfo, chatZone }
let activeMatches = new Map(); // matchId -> { p1, p2, signals, timestamp }

// Smart logging function
function smartLog(level, ...args) {
    if (ENABLE_DETAILED_LOGGING) {
        console.log(`[${level}]`, ...args);
    }
}

// Critical logs always show (errors, matches, etc.)
function criticalLog(level, ...args) {
    console.log(`[${level}]`, ...args);
}

// Helper function for CORS responses
function createCorsResponse(data, status = 200) {
    return new Response(data ? JSON.stringify(data) : null, {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        }
    });
}
function handleP2pConnected(userId, data) {
    const { matchId, partnerId } = data;
    console.log(`[P2PConnected] ${matchId}`);
    
    let removed = false;
    
    // Remove from waiting list
    if (waitingUsers.has(userId)) {
        const user = waitingUsers.get(userId);
        waitingUsers.delete(userId);
        removed = true;
        console.log(`[DISCONNECT] Removed ${userId} from waiting list`);
    }
    if (waitingUsers.has(partnerId)) {
        const user = waitingUsers.get(partnerId);
        waitingUsers.delete(partnerId);
        removed = true;
        console.log(`[DISCONNECT] Removed ${partnerId} from waiting list`);
    }
    activeMatches.delete(matchId);      
    
    return createCorsResponse({ 
        status: 'p2p_connected',
        removed,
        timestamp: Date.now()
    });
}
export default async function handler(req) {
    // Trigger cleanup on every request (since setInterval doesn't work in Edge Runtime)
    cleanup();
    
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return createCorsResponse(null, 200);
    }
    
    // GET: Health check and debug info
    if (req.method === 'GET') {
        const url = new URL(req.url);
        const debug = url.searchParams.get('debug');
        
        if (debug === 'true') {
            // Calculate timezone distribution for debugging
            const timezoneDistribution = {};
            for (const user of waitingUsers.values()) {
                const zone = user.chatZone || 'unknown';
                timezoneDistribution[zone] = (timezoneDistribution[zone] || 0) + 1;
            }
            
            // Simple distance matrix for debugging (limited to prevent slowdown)
            const waitingUsersArray = Array.from(waitingUsers.values());
            const distanceMatrix = [];
            const maxPairs = Math.min(20, (waitingUsersArray.length * (waitingUsersArray.length - 1)) / 2);
            
            let pairCount = 0;
            for (let i = 0; i < waitingUsersArray.length && pairCount < maxPairs; i++) {
                for (let j = i + 1; j < waitingUsersArray.length && pairCount < maxPairs; j++) {
                    const userA = waitingUsersArray[i];
                    const userB = waitingUsersArray[j];
                    const distances = calculateCircularTimezoneDistance(userA.chatZone, userB.chatZone);
                    
                    distanceMatrix.push({
                        userA: userA.userId.slice(-8),
                        userB: userB.userId.slice(-8),
                        zoneA: userA.chatZone,
                        zoneB: userB.chatZone,
                        linearDistance: distances.linear,
                        circularDistance: distances.circular,
                        score: calculateTimezoneScore(userA.chatZone, userB.chatZone)
                    });
                    pairCount++;
                }
            }
            
            return createCorsResponse({
                status: 'webrtc-signaling-server-timezone-circular',
                runtime: 'edge',
                performanceMode: ENABLE_DETAILED_LOGGING ? 'detailed-logging' : 'optimized-speed',
                config: {
                    userTimeout: USER_TIMEOUT,
                    matchLifetime: MATCH_LIFETIME,
                    maxWaitingUsers: MAX_WAITING_USERS,
                    timezoneMaxScore: TIMEZONE_MAX_SCORE,
                    timezonePenalty: TIMEZONE_PENALTY,
                    detailedLogging: ENABLE_DETAILED_LOGGING
                },
                stats: {
                    waitingUsers: waitingUsers.size,
                    activeMatches: activeMatches.size,
                    totalUsers: waitingUsers.size + (activeMatches.size * 2)
                },
                waitingUserIds: Array.from(waitingUsers.keys()),
                activeMatchIds: Array.from(activeMatches.keys()),
                timezoneDistribution,
                waitingUsersChatZones: Array.from(waitingUsers.values()).map(u => ({ 
                    userId: u.userId.slice(-8), 
                    chatZone: u.chatZone,
                    waitTime: Math.round((Date.now() - u.timestamp) / 1000)
                })),
                distanceMatrix: distanceMatrix, // Limited pairs for performance
                scoringConfig: {
                    maxScore: TIMEZONE_MAX_SCORE,
                    penalty: TIMEZONE_PENALTY,
                    circleHours: TIMEZONE_CIRCLE_HOURS,
                    algorithm: 'circular-distance',
                    detailedLogging: ENABLE_DETAILED_LOGGING
                },
                timestamp: Date.now()
            });
        }
        
        return createCorsResponse({ 
            status: 'signaling-ready',
            runtime: 'edge',
            performanceMode: ENABLE_DETAILED_LOGGING ? 'detailed-logging' : 'optimized-speed',
            stats: { 
                waiting: waitingUsers.size, 
                matches: activeMatches.size
            },
            message: 'WebRTC signaling server ready for connections with circular timezone matching',
            timestamp: Date.now()
        });
    }
    
    if (req.method !== 'POST') {
        return createCorsResponse({ error: 'POST required for signaling' }, 405);
    }
    
    try {
        // Parse request body
        const data = await req.json();
        
        const { action, userId, chatZone } = data;
        
        if (!userId) {
            return createCorsResponse({ error: 'userId is required' }, 400);
        }
        
        criticalLog(`${action?.toUpperCase() || 'UNKNOWN'}`, `${userId} (ChatZone: ${chatZone || 'N/A'})`);
        
        switch (action) {
            case 'instant-match': 
                return handleInstantMatch(userId, data);
            case 'get-signals': 
                return handleGetSignals(userId, data);
            case 'send-signal': 
                return handleSendSignal(userId, data);                
            case 'p2p-connected': 
                return handleP2pConnected(userId, data);      
            case 'disconnect': 
                return handleDisconnect(userId);
            default: 
                return createCorsResponse({ error: `Unknown action: ${action}` }, 400);
        }
    } catch (error) {
        criticalLog('SERVER ERROR', error);
        return createCorsResponse({ error: 'Server error', details: error.message }, 500);
    }
}

// ==========================================
// CIRCULAR TIMEZONE DISTANCE UTILITY
// ==========================================

function calculateCircularTimezoneDistance(userChatZone, partnerChatZone) {
    if (typeof userChatZone !== 'number' || typeof partnerChatZone !== 'number') {
        return {
            linear: null,
            circular: null,
            isValid: false
        };
    }
    
    // Calculate linear distance
    const linearDistance = Math.abs(userChatZone - partnerChatZone);
    
    // Calculate circular distance (optimized without Math.min for slight performance gain)
    const circularDistance = linearDistance > 12 ? TIMEZONE_CIRCLE_HOURS - linearDistance : linearDistance;
    
    return {
        linear: linearDistance,
        circular: circularDistance,
        isValid: true
    };
}

function calculateTimezoneScore(userChatZone, partnerChatZone) {
    const distances = calculateCircularTimezoneDistance(userChatZone, partnerChatZone);
    
    if (!distances.isValid) {
        return 1; // Default score if no timezone data
    }
    
    // Use circular distance for scoring
    const score = Math.max(0, TIMEZONE_MAX_SCORE - (distances.circular * TIMEZONE_PENALTY));
    
    smartLog('TIMEZONE-SCORE', `Zones ${userChatZone} <-> ${partnerChatZone}: linear=${distances.linear}h, circular=${distances.circular}h, score=${score}`);
    
    return score;
}

// ==========================================
// GENDER SCORING UTILITY
// ==========================================

function getGenderCoefficient(gender) {
    switch (gender) {
        case 'Male': return 1;
        case 'Female': return -1;
        case 'Unspecified':
        default: return 0;
    }
}

function calculateGenderScore(userGender, partnerGender) {
    const userCoeff = getGenderCoefficient(userGender);
    const partnerCoeff = getGenderCoefficient(partnerGender);
    
    // Formula: 3 - (genderA * genderB) - EXACT as requested (no Math.abs)
    // Male(1) × Female(-1):   3 - (1 × (-1)) = 3 - (-1) = 4 points (highest - different genders!)
    // Male(1) × Male(1):      3 - (1 × 1)    = 3 - 1 = 2 points (same gender)
    // Female(-1) × Female(-1): 3 - ((-1) × (-1)) = 3 - 1 = 2 points (same gender)
    // Any × Unspecified(0):   3 - (X × 0)     = 3 - 0 = 3 points (neutral)
    const genderScore = 3 - (userCoeff * partnerCoeff);
    
    smartLog('GENDER-SCORE', `${userGender}(${userCoeff}) × ${partnerGender}(${partnerCoeff}) = ${userCoeff * partnerCoeff}, score = 3 - (${userCoeff * partnerCoeff}) = ${genderScore} points`);
    
    return genderScore;
}

// ==========================================
// INSTANT MATCH HANDLER (WITH OPTIMIZED LOGGING)
// ==========================================

function handleInstantMatch(userId, data) {
    const { userInfo, preferredMatchId, chatZone, gender } = data;
    
    smartLog('INSTANT-MATCH', `${userId} looking for partner (ChatZone: ${chatZone})`);
    
    // Check if user is already waiting or matched
    if (waitingUsers.has(userId)) {
        waitingUsers.delete(userId);
        smartLog('INSTANT-MATCH', `Updated existing user ${userId}`);
    }
    
    // Remove user from any existing matches
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            smartLog('INSTANT-MATCH', `Removing ${userId} from existing match ${matchId}`);
            activeMatches.delete(matchId);
            break;
        }
    }
    
    // Try to find instant match from waiting users with circular timezone priority
    let bestMatch = null;
    let bestMatchScore = 0;
    let bestMatchDetails = null;
    
    for (const [waitingUserId, waitingUser] of waitingUsers.entries()) {
        if (waitingUserId === userId) continue;
        
        // Calculate compatibility score
        let score = 1; // Base score
        let scoreBreakdown = ENABLE_DETAILED_LOGGING ? { base: 1 } : null;
        
        // 🌍 CIRCULAR TIMEZONE MATCHING (Highest priority)
        const timezoneScore = calculateTimezoneScore(chatZone, waitingUser.chatZone);
        score += timezoneScore;
        if (scoreBreakdown) scoreBreakdown.timezone = timezoneScore;
        
        // Get distance details for logging (only if logging enabled)
        const distances = ENABLE_DETAILED_LOGGING ? calculateCircularTimezoneDistance(chatZone, waitingUser.chatZone) : null;
        
        // 👫 GENDER MATCHING (Formula-based)
        if (userInfo && waitingUser.userInfo) {
            const userGender = gender|| userInfo.gender || 'Unspecified';
            const partnerGender = waitingUser.userInfo.gender || 'Unspecified';
            
            const genderScore = calculateGenderScore(userGender, partnerGender);
            score += genderScore;
            if (scoreBreakdown) scoreBreakdown.gender = genderScore;
            
            // 😄 STATUS MATCHING
            if (userInfo.status && waitingUser.userInfo.status &&
                userInfo.status === waitingUser.userInfo.status) {
                score += 2; // Bonus for similar status/mood
                if (scoreBreakdown) scoreBreakdown.status = 2;
            }
        }
        
        // ⏱️ FRESHNESS BONUS
        const waitTime = Date.now() - waitingUser.timestamp;
        if (waitTime < 30000) {
            score += 1; // Less than 30 seconds
            if (scoreBreakdown) scoreBreakdown.freshness = 1;
        }
        if (waitTime < 10000) {
            score += 1; // Less than 10 seconds (very fresh)
            if (scoreBreakdown) scoreBreakdown.veryFresh = 1;
        }
        
        // Detailed logging only if enabled
        if (ENABLE_DETAILED_LOGGING && distances) {
            smartLog('MATCHING', `${waitingUserId} total score: ${score} | timezone: ${waitingUser.chatZone} (linear: ${distances.linear}h, circular: ${distances.circular}h, score: ${timezoneScore}) | gender: ${waitingUser.userInfo?.gender || 'N/A'} (score: ${scoreBreakdown?.gender || 0}) | wait: ${Math.round(waitTime/1000)}s | breakdown:`, scoreBreakdown);
        }
        
        if (score > bestMatchScore) {
            bestMatchScore = score;
            bestMatch = { userId: waitingUserId, user: waitingUser };
            bestMatchDetails = {
                totalScore: score,
                linearDistance: distances?.linear || null,
                circularDistance: distances?.circular || null,
                scoreBreakdown: scoreBreakdown,
                waitTime: Math.round(waitTime/1000)
            };
        }
    }
    
    if (bestMatch) {
        // INSTANT MATCH FOUND! 🚀
        const partnerId = bestMatch.userId;
        const partnerUser = bestMatch.user;
        
        // Remove partner from waiting list
        waitingUsers.delete(partnerId);
        
        // Create match
        const matchId = preferredMatchId || `match_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        // Determine who is initiator (consistent ordering)
        const isUserInitiator = userId < partnerId;
        const p1 = isUserInitiator ? userId : partnerId;
        const p2 = isUserInitiator ? partnerId : userId;
        
        // Create match without pre-exchanged signals
        const match = {
            p1,
            p2,
            timestamp: Date.now(),
            signals: {
                [p1]: [], // Initiator's signal queue
                [p2]: []  // Receiver's signal queue
            },
            userInfo: {
                [userId]: userInfo || {},
                [partnerId]: partnerUser.userInfo || {}
            },
            chatZones: {
                [userId]: chatZone,
                [partnerId]: partnerUser.chatZone
            },
            matchScore: bestMatchScore,
            matchDetails: bestMatchDetails
        };
        
        activeMatches.set(matchId, match);
        
        // Critical logging - always show successful matches
        if (ENABLE_DETAILED_LOGGING) {
            const timezoneInfo = bestMatchDetails.circularDistance !== null 
                ? ` | Timezone: ${chatZone} <-> ${partnerUser.chatZone} (linear: ${bestMatchDetails.linearDistance}h, circular: ${bestMatchDetails.circularDistance}h)`
                : '';
                
            const genderInfo = userInfo && partnerUser.userInfo 
                ? ` | Gender: ${gender || userInfo.gender || 'N/A'} <-> ${partnerUser.userInfo.gender || 'N/A'} (score: ${bestMatchDetails.scoreBreakdown?.gender || 0})`
                : '';
            
            criticalLog('INSTANT-MATCH', `🚀 ${userId} <-> ${partnerId} (${matchId}) - ${isUserInitiator ? 'INITIATOR' : 'RECEIVER'} | Score: ${bestMatchScore}${timezoneInfo}${genderInfo}`);
            criticalLog('MATCH-DETAILS', bestMatchDetails);
        } else {
            // Minimal logging for production
            criticalLog('INSTANT-MATCH', `🚀 ${userId} <-> ${partnerId} (${matchId}) | Score: ${bestMatchScore}`);
        }
        
        return createCorsResponse({
            status: 'instant-match',
            matchId,
            partnerId,
            isInitiator: isUserInitiator,
            partnerInfo: partnerUser.userInfo || {},
            partnerChatZone: partnerUser.chatZone,
            signals: [], // No pre-exchanged signals
            compatibility: bestMatchScore,
            timezoneDistance: bestMatchDetails.circularDistance,
            matchQuality: {
                totalScore: bestMatchScore,
                timezoneScore: bestMatchDetails.scoreBreakdown?.timezone || 0,
                genderScore: bestMatchDetails.scoreBreakdown?.gender || 0,
                linearDistance: bestMatchDetails.linearDistance,
                circularDistance: bestMatchDetails.circularDistance,
                breakdown: bestMatchDetails.scoreBreakdown
            },
            message: 'Instant match found! WebRTC connection will be established.',
            timestamp: Date.now()
        });
        
    } else {
        // No immediate match, add to waiting list with timezone
        const waitingUser = {
            userId,
            userInfo: userInfo || {},
            chatZone: chatZone || null,
            timestamp: Date.now()
        };
        
        waitingUsers.set(userId, waitingUser);
        
        const position = waitingUsers.size;
        smartLog('INSTANT-MATCH', `${userId} added to waiting list (position ${position}, chatZone: ${chatZone}, gender: ${userInfo?.gender || 'N/A'})`);
        
        // Calculate potential matches (only if detailed logging enabled to save performance)
        const potentialMatches = [];
        if (ENABLE_DETAILED_LOGGING) {
            for (const [waitingUserId, waitingUserData] of waitingUsers.entries()) {
                if (waitingUserId !== userId) {
                    const timezoneScore = calculateTimezoneScore(chatZone, waitingUserData.chatZone);
                    const distances = calculateCircularTimezoneDistance(chatZone, waitingUserData.chatZone);
                    
                    // Calculate gender score for potential match
                    let genderScore = 0;
                    if (userInfo && waitingUserData.userInfo) {
                        genderScore = calculateGenderScore(
                            gender || userInfo.gender || 'Unspecified', 
                            waitingUserData.userInfo.gender || 'Unspecified'
                        );
                    }
                    
                    potentialMatches.push({ 
                        userId: waitingUserId.slice(-8), 
                        chatZone: waitingUserData.chatZone, 
                        gender: waitingUserData.userInfo?.gender || 'N/A',
                        timezoneScore: timezoneScore,
                        genderScore: genderScore,
                        totalEstimatedScore: 1 + timezoneScore + genderScore,
                        linearDistance: distances.linear,
                        circularDistance: distances.circular
                    });
                }
            }
            potentialMatches.sort((a, b) => b.totalEstimatedScore - a.totalEstimatedScore);
        }
        
        return createCorsResponse({
            status: 'waiting',
            position,
            waitingUsers: waitingUsers.size,
            chatZone: chatZone,
            userGender: userInfo?.gender || 'Unspecified',
            potentialMatches: ENABLE_DETAILED_LOGGING ? potentialMatches.slice(0, 5) : [], // Only include if logging enabled
            message: 'Added to matching queue. Waiting for partner...',
            estimatedWaitTime: Math.min(waitingUsers.size * 2, 30),
            timestamp: Date.now()
        });
    }
}

// ==========================================
// SIGNAL HANDLERS (Updated with smart logging)
// ==========================================

function handleGetSignals(userId, data) {
    const { chatZone, gender } = data;
    
    // Find user's match
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            const signals = match.signals[userId] || [];
            
            // Clear signals after reading to prevent duplicates
            match.signals[userId] = [];
            
            smartLog('GET-SIGNALS', `${userId} -> ${signals.length} signals from match ${matchId}`);
            
            return createCorsResponse({
                status: 'matched',
                matchId,
                partnerId,
                isInitiator: match.p1 === userId,
                signals,
                partnerChatZone: match.chatZones ? match.chatZones[partnerId] : null,
                matchScore: match.matchScore || null,
                timestamp: Date.now()
            });
        }
    }
    
    // Check if still in waiting list
    if (waitingUsers.has(userId)) {
        const position = Array.from(waitingUsers.keys()).indexOf(userId) + 1;
        return createCorsResponse({
            status: 'waiting',
            position,
            waitingUsers: waitingUsers.size,
            chatZone: chatZone,
            userGender: gender || 'Unspecified',
            timestamp: Date.now()
        });
    }
    
    return createCorsResponse({
        status: 'not_found',
        message: 'User not found in waiting list or active matches',
        timestamp: Date.now()
    });
}

function handleSendSignal(userId, data) {
    const { matchId, type, payload } = data;
    
    if (!matchId || !type || !payload) {
        return createCorsResponse({ 
            error: 'Missing required fields',
            required: ['matchId', 'type', 'payload']
        }, 400);
    }
    
    const match = activeMatches.get(matchId);
    if (!match) {
        smartLog('SEND-SIGNAL', `Match ${matchId} not found`);
        return createCorsResponse({ 
            error: 'Match not found',
            matchId,
            availableMatches: Array.from(activeMatches.keys())
        }, 404);
    }
    
    if (match.p1 !== userId && match.p2 !== userId) {
        return createCorsResponse({ error: 'User not in this match' }, 403);
    }
    
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    
    // Add signal to partner's queue
    if (!match.signals[partnerId]) {
        match.signals[partnerId] = [];
    }
    
    const signal = {
        type,
        payload,
        from: userId,
        timestamp: Date.now()
    };
    
    match.signals[partnerId].push(signal);
    
    // Limit signal queue size to prevent memory bloat
    if (match.signals[partnerId].length > 100) {
        match.signals[partnerId] = match.signals[partnerId].slice(-50);
        smartLog('SEND-SIGNAL', `Trimmed signal queue for ${partnerId}`);
    }
    
    smartLog('SEND-SIGNAL', `${userId} -> ${partnerId} (${type}) in match ${matchId}`);
    
    return createCorsResponse({
        status: 'sent',
        partnerId,
        signalType: type,
        queueLength: match.signals[partnerId].length,
        timestamp: Date.now()
    });
}

function handleDisconnect(userId) {
    criticalLog('DISCONNECT', userId);
    
    let removed = false;
    let userChatZone = null;
    
    // Remove from waiting list
    if (waitingUsers.has(userId)) {
        const user = waitingUsers.get(userId);
        userChatZone = user.chatZone;
        waitingUsers.delete(userId);
        removed = true;
        smartLog('DISCONNECT', `Removed ${userId} from waiting list (chatZone: ${userChatZone})`);
    }
    
    // Remove from active matches and notify partner
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            userChatZone = match.chatZones ? match.chatZones[userId] : null;
            const partnerChatZone = match.chatZones ? match.chatZones[partnerId] : null;
            
            // Log circular distance for disconnection (only if detailed logging)
            if (ENABLE_DETAILED_LOGGING && userChatZone !== null && partnerChatZone !== null) {
                const distances = calculateCircularTimezoneDistance(userChatZone, partnerChatZone);
                smartLog('DISCONNECT', `Match had circular distance: ${distances.circular}h (linear: ${distances.linear}h)`);
            }
            
            // Add disconnect signal to partner's queue
            if (match.signals[partnerId]) {
                match.signals[partnerId].push({
                    type: 'disconnect',
                    payload: { reason: 'partner_disconnected' },
                    from: userId,
                    timestamp: Date.now()
                });
            }
            
            criticalLog('DISCONNECT', `Removing match ${matchId}, notifying ${partnerId}`);
            
            // Remove match immediately
            activeMatches.delete(matchId);
            smartLog('DISCONNECT', `Match ${matchId} cleaned up immediately`);
            
            removed = true;
            break;
        }
    }
    
    return createCorsResponse({ 
        status: 'disconnected',
        removed,
        userChatZone,
        timestamp: Date.now()
    });
}

// ==========================================
// CLEANUP UTILITIES (Called on every request instead of setInterval)
// ==========================================

function cleanup() {
    const now = Date.now();
    let cleanedUsers = 0;
    let cleanedMatches = 0;
    
    // Track timezone stats before cleanup (only if detailed logging)
    const beforeCleanupStats = ENABLE_DETAILED_LOGGING ? {} : null;
    if (beforeCleanupStats) {
        for (const user of waitingUsers.values()) {
            const zone = user.chatZone || 'unknown';
            beforeCleanupStats[zone] = (beforeCleanupStats[zone] || 0) + 1;
        }
    }
    
    // Clean expired waiting users
    for (const [userId, user] of waitingUsers.entries()) {
        if (now - user.timestamp > USER_TIMEOUT) {
            smartLog('CLEANUP', `Removing expired user ${userId} (chatZone: ${user.chatZone})`);
            waitingUsers.delete(userId);
            cleanedUsers++;
        }
    }
    
    // Clean old matches
    for (const [matchId, match] of activeMatches.entries()) {
        if (now - match.timestamp > MATCH_LIFETIME) {
            if (ENABLE_DETAILED_LOGGING) {
                let zones = 'N/A';
                if (match.chatZones) {
                    const userZone = match.chatZones[match.p1];
                    const partnerZone = match.chatZones[match.p2];
                    const distances = calculateCircularTimezoneDistance(userZone, partnerZone);
                    zones = `${userZone} <-> ${partnerZone} (circular: ${distances.circular}h)`;
                }
                smartLog('CLEANUP', `Removing expired match ${matchId} (chatZones: ${zones})`);
            }
            activeMatches.delete(matchId);
            cleanedMatches++;
        }
    }
    
    // Prevent memory bloat - remove oldest users if too many waiting
    if (waitingUsers.size > MAX_WAITING_USERS) {
        const excess = waitingUsers.size - MAX_WAITING_USERS;
        const oldestUsers = Array.from(waitingUsers.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp)
            .slice(0, excess);
        
        oldestUsers.forEach(([userId, user]) => {
            smartLog('CLEANUP', `Capacity limit: removing ${userId} (chatZone: ${user.chatZone})`);
            waitingUsers.delete(userId);
            cleanedUsers++;
        });
        
        criticalLog('CLEANUP', `Removed ${excess} oldest users due to capacity limit`);
    }
    
    if (cleanedUsers > 0 || cleanedMatches > 0) {
        criticalLog('CLEANUP', `Removed ${cleanedUsers} expired users, ${cleanedMatches} old matches. Active: ${waitingUsers.size} waiting, ${activeMatches.size} matched`);
        
        if (ENABLE_DETAILED_LOGGING) {
            const afterCleanupStats = {};
            for (const user of waitingUsers.values()) {
                const zone = user.chatZone || 'unknown';
                afterCleanupStats[zone] = (afterCleanupStats[zone] || 0) + 1;
            }
            
            smartLog('CLEANUP', `Timezone distribution - Before:`, beforeCleanupStats, 'After:', afterCleanupStats);
            
            // Log circular distance stats for remaining users
            if (waitingUsers.size > 1) {
                const users = Array.from(waitingUsers.values());
                let totalCircularDistance = 0;
                let pairCount = 0;
                
                for (let i = 0; i < users.length; i++) {
                    for (let j = i + 1; j < users.length; j++) {
                        const distances = calculateCircularTimezoneDistance(users[i].chatZone, users[j].chatZone);
                        if (distances.isValid) {
                            totalCircularDistance += distances.circular;
                            pairCount++;
                        }
                    }
                }
                
                if (pairCount > 0) {
                    const avgCircularDistance = (totalCircularDistance / pairCount).toFixed(1);
                    smartLog('CLEANUP', `Average circular distance among waiting users: ${avgCircularDistance}h (${pairCount} pairs)`);
                }
            }
        }
    }
}

// Edge Runtime configuration
export const config = { runtime: 'edge' };

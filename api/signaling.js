// 🚀 WebRTC Signaling Server with Swap-Based Timezone Matching
// Edge Runtime Compatible - Optimized for Vercel

// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================

const ENABLE_DETAILED_LOGGING = false;

// Configuration constants
const USER_TIMEOUT = 120000; // 2 minutes for waiting users
const MATCH_LIFETIME = 600000; // 10 minutes for active matches
const MAX_WAITING_USERS = 120000; // Prevent memory bloat

// Timezone scoring constants
const TIMEZONE_MAX_SCORE = 20; // Maximum points for same timezone
const TIMEZONE_PENALTY = 1; // Points deducted per hour difference
const TIMEZONE_CIRCLE_HOURS = 24; // 24-hour timezone circle (fixed)

// Swap strategy constants
const SWAP_COOLDOWN = 2000; // 2 seconds between swaps
const MAX_SWAP_ATTEMPTS = 3; // Max swaps per failed match

// ==========================================
// GLOBAL STATE
// ==========================================

let waitingUsers = new Map(); // userId -> { userId, timestamp, userInfo, chatZone }
let activeMatches = new Map(); // matchId -> { p1, p2, signals, timestamp }
let sortedUsersByTimezone = []; // Array sorted by chatZone for efficient matching
let lastSwapTime = 0; // Global swap cooldown
let requestCount = 0;
let lastResetTime = Date.now();

// ==========================================
// LOGGING UTILITIES
// ==========================================

function smartLog(level, ...args) {
    if (ENABLE_DETAILED_LOGGING) {
        console.log(`[${level}]`, ...args);
    }
}

function criticalLog(level, ...args) {
    console.log(`[${level}]`, ...args);
}

function logWithContext(level, action, userId, context = {}) {
    const timestamp = new Date().toISOString();
    const shortId = userId ? userId.slice(-8) : 'N/A';
    const contextStr = Object.keys(context).length > 0 ? JSON.stringify(context) : '';
    
    if (level === 'CRITICAL' || !ENABLE_DETAILED_LOGGING) {
        if (level === 'CRITICAL') {
            console.log(`[${timestamp}] [${level}] ${action} - ${shortId} ${contextStr}`);
        }
    } else {
        console.log(`[${timestamp}] [${level}] ${action} - ${shortId} ${contextStr}`);
    }
}

// ==========================================
// CORS & RESPONSE UTILITIES
// ==========================================

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

// ==========================================
// SORTED LIST MAINTENANCE
// ==========================================

function maintainSortedList() {
    const usersWithValidTimezone = Array.from(waitingUsers.values())
        .filter(user => typeof user.chatZone === 'number' && 
                       user.chatZone >= -12 && user.chatZone <= 12);
    
    usersWithValidTimezone.sort((a, b) => {
        if (a.chatZone !== b.chatZone) {
            return a.chatZone - b.chatZone;
        }
        return a.timestamp - b.timestamp;
    });
    
    sortedUsersByTimezone = usersWithValidTimezone;
    
    smartLog('SORTED-LIST', `Rebuilt: ${sortedUsersByTimezone.length} users with valid timezones`);
}

// ==========================================
// TIMEZONE CALCULATION UTILITIES
// ==========================================

function calculateCircularTimezoneDistance(userChatZone, partnerChatZone) {
    if (typeof userChatZone !== 'number' || typeof partnerChatZone !== 'number') {
        return {
            linear: null,
            circular: null,
            isValid: false
        };
    }
    
    const linearDistance = Math.abs(userChatZone - partnerChatZone);
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
        return Math.floor(TIMEZONE_MAX_SCORE / 2); // 10 points for invalid timezone
    }
    
    const score = Math.max(0, TIMEZONE_MAX_SCORE - (distances.circular * TIMEZONE_PENALTY));
    
    smartLog('TIMEZONE-SCORE', `Zones ${userChatZone} <-> ${partnerChatZone}: linear=${distances.linear}h, circular=${distances.circular}h, score=${score}`);
    
    return score;
}

// ==========================================
// GENDER SCORING UTILITIES
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
    
    const genderScore = 3 - (userCoeff * partnerCoeff);
    
    smartLog('GENDER-SCORE', `${userGender}(${userCoeff}) × ${partnerGender}(${partnerCoeff}) = ${userCoeff * partnerCoeff}, score = 3 - (${userCoeff * partnerCoeff}) = ${genderScore} points`);
    
    return genderScore;
}

// ==========================================
// SWAP INFORMATION STRATEGY
// ==========================================

function swapUserInformation(failedUserId, userChatZone) {
    const now = Date.now();
    
    if (now - lastSwapTime < SWAP_COOLDOWN) {
        smartLog('SWAP', `Swap cooldown active, skipping swap for ${failedUserId.slice(-8)}`);
        return false;
    }
    
    if (!failedUserId || typeof userChatZone !== 'number') {
        smartLog('SWAP', `Invalid inputs: failedUserId=${failedUserId}, userChatZone=${userChatZone}`);
        return false;
    }
    
    const failedUser = waitingUsers.get(failedUserId);
    if (!failedUser || failedUser.chatZone !== userChatZone) {
        smartLog('SWAP', `Failed user ${failedUserId.slice(-8)} not found or zone mismatch`);
        return false;
    }
    
    const sameZoneUsers = Array.from(waitingUsers.values()).filter(user => 
        user.chatZone === userChatZone && 
        user.userId !== failedUserId &&
        user.userInfo
    );
    
    if (sameZoneUsers.length === 0) {
        smartLog('SWAP', `No valid users in zone ${userChatZone} to swap with ${failedUserId.slice(-8)}`);
        return false;
    }
    
    const randomIndex = Math.floor(Math.random() * sameZoneUsers.length);
    const swapTargetUser = sameZoneUsers[randomIndex];
    const swapTargetUserId = swapTargetUser.userId;
    
    // Deep clone to avoid reference issues
    const failedUserInfo = failedUser.userInfo ? JSON.parse(JSON.stringify(failedUser.userInfo)) : {};
    const swapTargetUserInfo = swapTargetUser.userInfo ? JSON.parse(JSON.stringify(swapTargetUser.userInfo)) : {};
    const failedUserTimestamp = failedUser.timestamp;
    const swapTargetTimestamp = swapTargetUser.timestamp;
    
    // Perform the swap
    failedUser.userInfo = swapTargetUserInfo;
    failedUser.timestamp = swapTargetTimestamp;
    
    swapTargetUser.userInfo = failedUserInfo;
    swapTargetUser.timestamp = failedUserTimestamp;
    
    // Ensure Map is updated
    waitingUsers.set(failedUserId, failedUser);
    waitingUsers.set(swapTargetUserId, swapTargetUser);
    
    maintainSortedList();
    
    lastSwapTime = now;
    
    criticalLog('SWAP-INFO', `🔄 Swapped information: ${failedUserId.slice(-8)} ↔ ${swapTargetUserId.slice(-8)} in zone ${userChatZone}`);
    
    if (ENABLE_DETAILED_LOGGING) {
        smartLog('SWAP-DETAILS', {
            failed: { 
                id: failedUserId.slice(-8), 
                newInfo: failedUser.userInfo,
                newTimestamp: failedUser.timestamp
            },
            target: { 
                id: swapTargetUserId.slice(-8), 
                newInfo: swapTargetUser.userInfo,
                newTimestamp: swapTargetUser.timestamp
            }
        });
    }
    
    return true;
}

// ==========================================
// OPTIMIZED PARTNER FINDING
// ==========================================

function findClosestPartners(userChatZone, userId) {
    if (typeof userChatZone !== 'number' || sortedUsersByTimezone.length === 0) {
        return [];
    }
    
    const candidates = [];
    const userZone = userChatZone;
    
    let insertIndex = 0;
    for (let i = 0; i < sortedUsersByTimezone.length; i++) {
        if (sortedUsersByTimezone[i].chatZone >= userZone) {
            insertIndex = i;
            break;
        }
        insertIndex = i + 1;
    }
    
    // Priority 1: Same timezone users first
    for (let i = 0; i < sortedUsersByTimezone.length; i++) {
        const user = sortedUsersByTimezone[i];
        if (user.chatZone === userZone && user.userId !== userId) {
            candidates.push({
                user: user,
                circularDistance: 0,
                linearDistance: 0,
                priority: 'same-zone',
                index: i
            });
        }
    }
    
    // Priority 2: Adjacent timezones
    const searchRadius = Math.min(6, sortedUsersByTimezone.length);
    
    for (let radius = 1; radius <= searchRadius; radius++) {
        if (insertIndex - radius >= 0) {
            const leftUser = sortedUsersByTimezone[insertIndex - radius];
            if (leftUser.userId !== userId && leftUser.chatZone !== userZone) {
                const distance = calculateCircularTimezoneDistance(userZone, leftUser.chatZone);
                if (distance.isValid) {
                    candidates.push({
                        user: leftUser,
                        circularDistance: distance.circular,
                        linearDistance: distance.linear,
                        priority: 'adjacent',
                        index: insertIndex - radius
                    });
                }
            }
        }
        
        if (insertIndex + radius < sortedUsersByTimezone.length) {
            const rightUser = sortedUsersByTimezone[insertIndex + radius];
            if (rightUser.userId !== userId && rightUser.chatZone !== userZone) {
                const distance = calculateCircularTimezoneDistance(userZone, rightUser.chatZone);
                if (distance.isValid) {
                    candidates.push({
                        user: rightUser,
                        circularDistance: distance.circular,
                        linearDistance: distance.linear,
                        priority: 'adjacent',
                        index: insertIndex + radius
                    });
                }
            }
        }
    }
    
    candidates.sort((a, b) => {
        if (a.priority === 'same-zone' && b.priority !== 'same-zone') return -1;
        if (b.priority === 'same-zone' && a.priority !== 'same-zone') return 1;
        
        if (a.circularDistance !== b.circularDistance) {
            return a.circularDistance - b.circularDistance;
        }
        return a.linearDistance - b.linearDistance;
    });
    
    return candidates;
}

// ==========================================
// ENHANCED INSTANT MATCH HANDLER
// ==========================================

function handleInstantMatch(userId, data) {
    const { userInfo, preferredMatchId, chatZone, gender } = data;
    
    // RELAXED VALIDATION - chỉ check userId required
    if (!userId || typeof userId !== 'string') {
        return createCorsResponse({ error: 'userId is required and must be string' }, 400);
    }
    
    // Optional validation cho chatZone - allow null/undefined
    if (chatZone !== null && chatZone !== undefined && 
        (typeof chatZone !== 'number' || chatZone < -12 || chatZone > 12)) {
        return createCorsResponse({ 
            error: 'Invalid chatZone - must be number between -12 and 12, or null/undefined',
            received: { chatZone, type: typeof chatZone }
        }, 400);
    }
    
    smartLog('INSTANT-MATCH', `${userId.slice(-8)} looking for partner (ChatZone: ${chatZone})`);
    
    if (waitingUsers.has(userId)) {
        waitingUsers.delete(userId);
        smartLog('INSTANT-MATCH', `Updated existing user ${userId.slice(-8)}`);
    }
    
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            smartLog('INSTANT-MATCH', `Removing ${userId.slice(-8)} from existing match ${matchId}`);
            activeMatches.delete(matchId);
            break;
        }
    }
    
    maintainSortedList();
    
    let bestMatch = null;
    let bestMatchScore = 0;
    let bestMatchDetails = null;
    let failedPartnerId = null;
    
    if (typeof chatZone === 'number' && chatZone >= -12 && chatZone <= 12) {
        const closestCandidates = findClosestPartners(chatZone, userId);
        
        smartLog('OPTIMIZED-SEARCH', `Found ${closestCandidates.length} candidates for user ${userId.slice(-8)} (zone: ${chatZone})`);
        
        const maxCandidates = Math.min(10, closestCandidates.length);
        
        for (let i = 0; i < maxCandidates; i++) {
            const candidate = closestCandidates[i];
            const waitingUser = candidate.user;
            const waitingUserId = waitingUser.userId;
            
            let score = 1;
            let scoreBreakdown = ENABLE_DETAILED_LOGGING ? { base: 1 } : null;
            
            const timezoneScore = Math.max(0, TIMEZONE_MAX_SCORE - (candidate.circularDistance * TIMEZONE_PENALTY));
            score += timezoneScore;
            if (scoreBreakdown) scoreBreakdown.timezone = timezoneScore;
            
            if (candidate.circularDistance === 0) {
                score += 5;
                if (scoreBreakdown) scoreBreakdown.sameTimezone = 5;
            } else if (candidate.circularDistance <= 1) {
                score += 3;
                if (scoreBreakdown) scoreBreakdown.veryClose = 3;
            } else if (candidate.circularDistance <= 3) {
                score += 1;
                if (scoreBreakdown) scoreBreakdown.close = 1;
            }
            
            if (userInfo && waitingUser.userInfo) {
                const userGender = gender || userInfo.gender || 'Unspecified';
                const partnerGender = waitingUser.userInfo.gender || 'Unspecified';
                const genderScore = calculateGenderScore(userGender, partnerGender);
                score += genderScore;
                if (scoreBreakdown) scoreBreakdown.gender = genderScore;
            }
            
            const waitTime = Date.now() - waitingUser.timestamp;
            if (waitTime < 30000) {
                score += 1;
                if (scoreBreakdown) scoreBreakdown.freshness = 1;
            }
            
            if (ENABLE_DETAILED_LOGGING) {
                smartLog('CANDIDATE-EVAL', `${waitingUserId.slice(-8)} | Distance: ${candidate.circularDistance}h | Score: ${score} | Breakdown:`, scoreBreakdown);
            }
            
            if (score > bestMatchScore) {
                bestMatchScore = score;
                bestMatch = { userId: waitingUserId, user: waitingUser };
                bestMatchDetails = {
                    totalScore: score,
                    linearDistance: candidate.linearDistance,
                    circularDistance: candidate.circularDistance,
                    scoreBreakdown: scoreBreakdown,
                    searchMethod: 'optimized-timezone',
                    candidateIndex: i
                };
            }
            
            if (candidate.circularDistance === 0 && score >= 25) {
                smartLog('EARLY-EXIT', `Perfect match found at candidate ${i}, stopping search`);
                break;
            }
        }
        
        if (closestCandidates.length > 0) {
            failedPartnerId = closestCandidates[0].user.userId;
        }
    }
    
    if (!bestMatch && waitingUsers.size > 0) {
        smartLog('FALLBACK-SEARCH', `No optimized match found, using traditional search for ${userId.slice(-8)}`);
        
        for (const [waitingUserId, waitingUser] of waitingUsers.entries()) {
            if (waitingUserId === userId) continue;
            
            let score = 1;
            const timezoneScore = calculateTimezoneScore(chatZone, waitingUser.chatZone);
            score += timezoneScore;
            
            if (userInfo && waitingUser.userInfo) {
                const genderScore = calculateGenderScore(
                    gender || userInfo.gender || 'Unspecified',
                    waitingUser.userInfo.gender || 'Unspecified'
                );
                score += genderScore;
            }
            
            if (score > bestMatchScore) {
                bestMatchScore = score;
                bestMatch = { userId: waitingUserId, user: waitingUser };
                bestMatchDetails = {
                    totalScore: score,
                    searchMethod: 'fallback-traditional'
                };
            }
        }
    }
    
    if (bestMatch) {
        const partnerId = bestMatch.userId;
        const partnerUser = bestMatch.user;
        
        waitingUsers.delete(partnerId);
        maintainSortedList();
        
        const matchId = preferredMatchId || `match_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        const isUserInitiator = userId < partnerId;
        const p1 = isUserInitiator ? userId : partnerId;
        const p2 = isUserInitiator ? partnerId : userId;
        
        const match = {
            p1, p2,
            timestamp: Date.now(),
            signals: { [p1]: [], [p2]: [] },
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
        
        const distanceInfo = bestMatchDetails.circularDistance !== undefined 
            ? ` | Distance: ${bestMatchDetails.circularDistance}h` 
            : '';
        const methodInfo = bestMatchDetails.searchMethod ? ` | Method: ${bestMatchDetails.searchMethod}` : '';
        
        criticalLog('INSTANT-MATCH', `🚀 ${userId.slice(-8)} <-> ${partnerId.slice(-8)} (${matchId}) | Score: ${bestMatchScore}${distanceInfo}${methodInfo}`);
        
        return createCorsResponse({
            status: 'instant-match',
            matchId, partnerId,
            isInitiator: isUserInitiator,
            partnerInfo: partnerUser.userInfo || {},
            partnerChatZone: partnerUser.chatZone,
            signals: [],
            compatibility: bestMatchScore,
            timezoneDistance: bestMatchDetails.circularDistance,
            matchQuality: {
                totalScore: bestMatchScore,
                linearDistance: bestMatchDetails.linearDistance,
                circularDistance: bestMatchDetails.circularDistance,
                searchMethod: bestMatchDetails.searchMethod,
                breakdown: bestMatchDetails.scoreBreakdown
            },
            message: 'Instant match found! WebRTC connection will be established.',
            timestamp: Date.now()
        });
        
    } else {
        if (failedPartnerId && typeof chatZone === 'number') {
            const closestCandidate = waitingUsers.get(failedPartnerId);
            if (closestCandidate && closestCandidate.chatZone === chatZone) {
                const swapSuccess = swapUserInformation(failedPartnerId, chatZone);
                if (swapSuccess) {
                    smartLog('SWAP-STRATEGY', `Applied swap strategy for future matching of ${userId.slice(-8)}`);
                }
            } else if (closestCandidate) {
                const swapSuccess = swapUserInformation(failedPartnerId, closestCandidate.chatZone);
                if (swapSuccess) {
                    smartLog('SWAP-STRATEGY', `Applied cross-zone swap strategy for ${userId.slice(-8)}`);
                }
            }
        }
        
        const waitingUser = {
            userId,
            userInfo: userInfo || {},
            chatZone: chatZone || null,
            timestamp: Date.now()
        };
        
        waitingUsers.set(userId, waitingUser);
        maintainSortedList();
        
        const position = waitingUsers.size;
        smartLog('INSTANT-MATCH', `${userId.slice(-8)} added to waiting list (position ${position}, chatZone: ${chatZone})`);
        
        return createCorsResponse({
            status: 'waiting',
            position,
            waitingUsers: waitingUsers.size,
            chatZone: chatZone,
            userGender: userInfo?.gender || 'Unspecified',
            swapApplied: failedPartnerId ? true : false,
            message: 'Added to matching queue. Waiting for partner...',
            estimatedWaitTime: Math.min(waitingUsers.size * 2, 30),
            timestamp: Date.now()
        });
    }
}

// ==========================================
// OTHER HANDLERS
// ==========================================

function handleGetSignals(userId, data) {
    const { chatZone, gender } = data;
    
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            const signals = match.signals[userId] || [];
            
            match.signals[userId] = [];
            
            smartLog('GET-SIGNALS', `${userId.slice(-8)} -> ${signals.length} signals from match ${matchId}`);
            
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
        return createCorsResponse({ 
            error: 'Match not found',
            matchId
        }, 404);
    }
    
    if (match.p1 !== userId && match.p2 !== userId) {
        return createCorsResponse({ error: 'User not in this match' }, 403);
    }
    
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    
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
    
    if (match.signals[partnerId].length > 100) {
        match.signals[partnerId] = match.signals[partnerId].slice(-50);
    }
    
    smartLog('SEND-SIGNAL', `${userId.slice(-8)} -> ${partnerId.slice(-8)} (${type}) in match ${matchId}`);
    
    return createCorsResponse({
        status: 'sent',
        partnerId,
        signalType: type,
        queueLength: match.signals[partnerId].length,
        timestamp: Date.now()
    });
}

function handleP2pConnected(userId, data) {
    const { matchId, partnerId } = data;
    criticalLog('P2P-CONNECTED', `${matchId} - ${userId.slice(-8)} connected`);
    
    let removed = false;
    
    if (waitingUsers.has(userId)) {
        waitingUsers.delete(userId);
        removed = true;
        criticalLog('P2P-CONNECTED', `Removed ${userId.slice(-8)} from waiting list`);
    }
    if (waitingUsers.has(partnerId)) {
        waitingUsers.delete(partnerId);
        removed = true;
        criticalLog('P2P-CONNECTED', `Removed ${partnerId.slice(-8)} from waiting list`);
    }
    
    activeMatches.delete(matchId);
    
    if (removed) {
        maintainSortedList();
    }
    
    return createCorsResponse({
        status: 'p2p_connected',
        removed,
        timestamp: Date.now()
    });
}

function handleDisconnect(userId) {
    criticalLog('DISCONNECT', userId.slice(-8));
    
    let removed = false;
    
    if (waitingUsers.has(userId)) {
        waitingUsers.delete(userId);
        removed = true;
        smartLog('DISCONNECT', `Removed ${userId.slice(-8)} from waiting list`);
    }
    
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            
            if (match.signals && match.signals[partnerId]) {
                match.signals[partnerId].push({
                    type: 'disconnect',
                    payload: { reason: 'partner_disconnected' },
                    from: userId,
                    timestamp: Date.now()
                });
            }
            
            criticalLog('DISCONNECT', `Removing match ${matchId}, notifying ${partnerId.slice(-8)}`);
            activeMatches.delete(matchId);
            removed = true;
            break;
        }
    }
    
    if (removed) {
        maintainSortedList();
    }
    
    return createCorsResponse({ 
        status: 'disconnected',
        removed,
        timestamp: Date.now()
    });
}

// ==========================================
// CLEANUP FUNCTION
// ==========================================

function cleanup() {
    const now = Date.now();
    let cleanedUsers = 0;
    let cleanedMatches = 0;
    
    const expiredUsers = [];
    for (const [userId, user] of waitingUsers.entries()) {
        if (now - user.timestamp > USER_TIMEOUT) {
            expiredUsers.push(userId);
        }
    }
    
    expiredUsers.forEach(userId => {
        waitingUsers.delete(userId);
        cleanedUsers++;
    });
    
    const expiredMatches = [];
    for (const [matchId, match] of activeMatches.entries()) {
        if (now - match.timestamp > MATCH_LIFETIME) {
            expiredMatches.push(matchId);
        }
    }
    
    expiredMatches.forEach(matchId => {
        activeMatches.delete(matchId);
        cleanedMatches++;
    });
    
    if (waitingUsers.size > MAX_WAITING_USERS) {
        const excess = waitingUsers.size - MAX_WAITING_USERS;
        const oldestUsers = Array.from(waitingUsers.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp)
            .slice(0, excess)
            .map(entry => entry[0]);
        
        oldestUsers.forEach(userId => {
            waitingUsers.delete(userId);
            cleanedUsers++;
        });
        
        criticalLog('CLEANUP', `Removed ${excess} oldest users due to capacity limit`);
    }
    
    // Reset swap state if no users waiting
    if (waitingUsers.size === 0) {
        lastSwapTime = 0;
        smartLog('CLEANUP', 'Reset swap state - no waiting users');
    }
    
    // Rebuild sorted list if any users were removed
    if (cleanedUsers > 0) {
        maintainSortedList();
    }
    
    if (cleanedUsers > 0 || cleanedMatches > 0) {
        criticalLog('CLEANUP', `Removed ${cleanedUsers} expired users, ${cleanedMatches} old matches. Active: ${waitingUsers.size} waiting, ${activeMatches.size} matched`);
    }
}

// ==========================================
// MAIN HANDLER FUNCTION
// ==========================================

export default async function handler(req) {   
    // Trigger cleanup on every request
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
            
            const performanceStats = {
                count: requestCount,
                period: Math.round((Date.now() - lastResetTime) / 1000),
                rps: requestCount / Math.max(1, (Date.now() - lastResetTime) / 1000)
            };
            
            return createCorsResponse({
                status: 'webrtc-signaling-server-swap-strategy',
                runtime: 'edge',
                performanceMode: ENABLE_DETAILED_LOGGING ? 'detailed-logging' : 'optimized-speed',
                config: {
                    userTimeout: USER_TIMEOUT,
                    matchLifetime: MATCH_LIFETIME,
                    maxWaitingUsers: MAX_WAITING_USERS,
                    timezoneMaxScore: TIMEZONE_MAX_SCORE,
                    timezonePenalty: TIMEZONE_PENALTY,
                    swapCooldown: SWAP_COOLDOWN,
                    maxSwapAttempts: MAX_SWAP_ATTEMPTS,
                    detailedLogging: ENABLE_DETAILED_LOGGING
                },
                stats: {
                    waitingUsers: waitingUsers.size,
                    activeMatches: activeMatches.size,
                    sortedUsers: sortedUsersByTimezone.length,
                    totalUsers: waitingUsers.size + (activeMatches.size * 2)
                },
                performance: performanceStats,
                waitingUserIds: Array.from(waitingUsers.keys()).map(id => id.slice(-8)),
                activeMatchIds: Array.from(activeMatches.keys()),
                timezoneDistribution,
                sortedUsersByTimezone: sortedUsersByTimezone.map(u => ({ 
                    userId: u.userId.slice(-8), 
                    chatZone: u.chatZone,
                    gender: u.userInfo?.gender || 'N/A',
                    waitTime: Math.round((Date.now() - u.timestamp) / 1000)
                })),
                distanceMatrix: distanceMatrix, // Limited pairs for performance
                swapStrategy: {
                    enabled: true,
                    lastSwapTime: lastSwapTime,
                    timeSinceLastSwap: Date.now() - lastSwapTime,
                    cooldownRemaining: Math.max(0, SWAP_COOLDOWN - (Date.now() - lastSwapTime))
                },
                scoringConfig: {
                    maxScore: TIMEZONE_MAX_SCORE,
                    penalty: TIMEZONE_PENALTY,
                    circleHours: TIMEZONE_CIRCLE_HOURS,
                    algorithm: 'circular-distance-with-swap',
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
                matches: activeMatches.size,
                sorted: sortedUsersByTimezone.length
            },
            message: 'WebRTC signaling server with swap-based timezone matching ready',
            timestamp: Date.now()
        });
    }
    
    if (req.method !== 'POST') {
        return createCorsResponse({ error: 'POST required for signaling' }, 405);
    }
    
    try {
        // FLEXIBLE JSON PARSING - handle both string and object body như code cũ
        let data;
        let requestBody = '';
        
        try {
            // Method 1: Try req.json() first (works in some environments)
            try {
                data = await req.json();
                criticalLog('PARSE-SUCCESS', 'Used req.json() method');
            } catch (jsonError) {
                // Method 2: Manual stream reading (for problematic Edge Runtime)
                if (!req.body) {
                    return createCorsResponse({ 
                        error: 'No request body found',
                        method: req.method,
                        tip: 'Make sure to send JSON body with your POST request'
                    }, 400);
                }
                
                // Read body stream
                const reader = req.body.getReader();
                const decoder = new TextDecoder();
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    requestBody += decoder.decode(value, { stream: true });
                }
                
                if (!requestBody.trim()) {
                    return createCorsResponse({ 
                        error: 'Empty request body',
                        tip: 'Send JSON data like: {"action":"instant-match","userId":"123"}'
                    }, 400);
                }
                
                // Parse the body - handle both string and object như code cũ
                if (typeof requestBody === 'string') {
                    data = JSON.parse(requestBody);
                } else {
                    data = requestBody;
                }
                
                criticalLog('PARSE-SUCCESS', 'Used manual stream reading method');
            }
            
        } catch (parseError) {
            return createCorsResponse({ 
                error: 'Invalid JSON in request body',
                details: parseError.message,
                receivedBody: requestBody.substring(0, 200),
                tip: 'Check your JSON syntax - should be valid JSON object'
            }, 400);
        }
        
        const { action, userId, chatZone } = data;
        
        if (!userId) {
            return createCorsResponse({ 
                error: 'userId is required',
                received: data,
                tip: 'Include userId in your JSON: {"userId":"your-user-id",...}'
            }, 400);
        }
        
        if (!action) {
            return createCorsResponse({ 
                error: 'action is required',
                received: data,
                validActions: ['instant-match', 'get-signals', 'send-signal', 'p2p-connected', 'disconnect'],
                tip: 'Include action in your JSON: {"action":"instant-match",...}'
            }, 400);
        }
        
        // Enhanced logging
        criticalLog(`${action.toUpperCase()}`, `${userId.slice(-8)} (Zone: ${chatZone || 'N/A'})`);
        
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
        criticalLog('SERVER ERROR', `Error: ${error.message} | Stack: ${error.stack}`);
        return createCorsResponse({ 
            error: 'Server error', 
            details: error.message,
            type: error.name,
            serverTime: new Date().toISOString()
        }, 500);
    }
}

// Edge Runtime configuration
export const config = { runtime: 'edge' };

const ENABLE_DETAILED_LOGGING = false;

const USER_TIMEOUT = 120000;
const MATCH_LIFETIME = 600000;
const MAX_WAITING_USERS = 120000;
const TIMEZONE_MAX_SCORE = 20;
const TIMEZONE_PENALTY = 1;

let waitingUsers = new Map();
let timezoneUsers = new Map();
let activeMatches = new Map();
let requestCount = 0;
let lastResetTime = Date.now();

let distanceCache = new Map();
let timezoneScoreTable = new Array(25);
let genderScoreTable = new Map();

function initializeOptimizations() {
    for (let distance = 0; distance <= 24; distance++) {
        timezoneScoreTable[distance] = Math.max(0, TIMEZONE_MAX_SCORE - (distance * TIMEZONE_PENALTY));
    }
    
    const genders = ['Male', 'Female', 'Unspecified'];
    const genderCoeffs = { 'Male': 1, 'Female': -1, 'Unspecified': 0 };
    
    for (const g1 of genders) {
        for (const g2 of genders) {
            const coeff1 = genderCoeffs[g1];
            const coeff2 = genderCoeffs[g2];
            const score = 3 - (coeff1 * coeff2);
            genderScoreTable.set(`${g1},${g2}`, score);
        }
    }
}

initializeOptimizations();

function trackRequest() {
    requestCount++;
    if (Date.now() - lastResetTime > 3600000) {
        requestCount = 0;
        lastResetTime = Date.now();
    }
}

function smartLog(level, ...args) {
    if (ENABLE_DETAILED_LOGGING) {
        console.log(`[${level}]`, ...args);
    }
}

function criticalLog(level, ...args) {
    console.log(`[${level}]`, ...args);
}

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

function getCircularDistance(zone1, zone2) {
    if (typeof zone1 !== 'number' || typeof zone2 !== 'number') return 12;
    
    const cacheKey = zone1 <= zone2 ? `${zone1},${zone2}` : `${zone2},${zone1}`;
    
    if (distanceCache.has(cacheKey)) {
        return distanceCache.get(cacheKey);
    }
    
    const linear = Math.abs(zone1 - zone2);
    const circular = linear > 12 ? 24 - linear : linear;
    
    if (distanceCache.size >= 1000) {
        const firstKey = distanceCache.keys().next().value;
        distanceCache.delete(firstKey);
    }
    distanceCache.set(cacheKey, circular);
    
    return circular;
}

function getTimezoneScore(zone1, zone2) {
    const distance = getCircularDistance(zone1, zone2);
    return timezoneScoreTable[distance] || 0;
}

function getGenderScore(gender1, gender2) {
    const key = `${gender1 || 'Unspecified'},${gender2 || 'Unspecified'}`;
    return genderScoreTable.get(key) || 3;
}

function addUserToIndexes(userId, user) {
    waitingUsers.set(userId, user);
    
    const chatZone = user.chatZone;
    if (typeof chatZone === 'number') {
        if (!timezoneUsers.has(chatZone)) {
            timezoneUsers.set(chatZone, new Map());
        }
        timezoneUsers.get(chatZone).set(userId, user);
    }
}

function removeUserFromIndexes(userId, chatZone = null) {
    const user = waitingUsers.get(userId);
    if (!user) return false;
    
    waitingUsers.delete(userId);
    
    const userZone = chatZone || user.chatZone;
    if (typeof userZone === 'number' && timezoneUsers.has(userZone)) {
        timezoneUsers.get(userZone).delete(userId);
        if (timezoneUsers.get(userZone).size === 0) {
            timezoneUsers.delete(userZone);
        }
    }
    
    return true;
}

function findBestMatch(userId, userChatZone, userGender) {
    if (typeof userChatZone !== 'number') {
        for (const [candidateId, candidate] of waitingUsers.entries()) {
            if (candidateId !== userId) {
                let score = 1;
                score += getTimezoneScore(userChatZone, candidate.chatZone);
                score += getGenderScore(userGender, candidate.userInfo?.gender);
                if (Date.now() - candidate.timestamp < 30000) score += 2;
                return { userId: candidateId, user: candidate, score };
            }
        }
        return null;
    }
    
    const searchZones = [];
    for (let distance = 0; distance <= 12; distance++) {
        const zone1 = ((userChatZone + distance + 12) % 24) - 12;
        const zone2 = ((userChatZone - distance + 12) % 24) - 12;
        
        if (distance === 0) {
            searchZones.push({ zone: zone1, distance });
        } else {
            searchZones.push({ zone: zone1, distance }, { zone: zone2, distance });
        }
    }
    
    let bestMatch = null;
    let bestScore = 0;
    
    for (const { zone, distance } of searchZones) {
        const zoneUserMap = timezoneUsers.get(zone);
        if (!zoneUserMap || zoneUserMap.size === 0) continue;
        
        for (const [candidateId, candidate] of zoneUserMap.entries()) {
            if (candidateId === userId) continue;
            
            let score = 1 + timezoneScoreTable[distance];
            score += getGenderScore(userGender, candidate.userInfo?.gender);
            if (Date.now() - candidate.timestamp < 30000) score += 2;
            
            if (score > bestScore) {
                bestScore = score;
                bestMatch = { userId: candidateId, user: candidate, score };
            }
            
            if (distance === 0 && score >= 25) {
                return bestMatch;
            }
        }
        
        if (bestMatch && distance <= 1 && bestScore >= 20) {
            return bestMatch;
        }
    }
    
    return bestMatch;
}

function handleInstantMatch(userId, data) {
    const { userInfo, preferredMatchId, chatZone, gender } = data;
    
    if (!userId || typeof userId !== 'string') {
        return createCorsResponse({ error: 'userId is required and must be string' }, 400);
    }
    
    smartLog('INSTANT-MATCH', `${userId.slice(-8)} looking for partner (ChatZone: ${chatZone})`);
    
    removeUserFromIndexes(userId, chatZone);
    
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            activeMatches.delete(matchId);
            break;
        }
    }
    
    const userGender = gender || userInfo?.gender || 'Unspecified';
    const bestMatch = findBestMatch(userId, chatZone, userGender);
    
    if (bestMatch) {
        const partnerId = bestMatch.userId;
        const partnerUser = bestMatch.user;
        
        removeUserFromIndexes(partnerId, partnerUser.chatZone);
        
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
            matchScore: bestMatch.score
        };
        
        activeMatches.set(matchId, match);
        
        criticalLog('INSTANT-MATCH', `🚀 ${userId.slice(-8)} <-> ${partnerId.slice(-8)} (${matchId}) | Score: ${bestMatch.score}`);
        
        return createCorsResponse({
            status: 'instant-match',
            matchId,
            partnerId,
            isInitiator: isUserInitiator,
            partnerInfo: partnerUser.userInfo || {},
            partnerChatZone: partnerUser.chatZone,
            signals: [],
            compatibility: bestMatch.score,
            message: 'Instant match found! WebRTC connection will be established.',
            timestamp: Date.now()
        });
        
    } else {
        const waitingUser = {
            userId,
            userInfo: userInfo || {},
            chatZone: chatZone || null,
            timestamp: Date.now()
        };
        
        addUserToIndexes(userId, waitingUser);
        
        const position = waitingUsers.size;
        smartLog('INSTANT-MATCH', `${userId.slice(-8)} added to waiting list (position ${position})`);
        
        return createCorsResponse({
            status: 'waiting',
            position,
            waitingUsers: waitingUsers.size,
            chatZone: chatZone,
            userGender: userGender,
            message: 'Added to matching queue. Waiting for partner...',
            estimatedWaitTime: Math.min(waitingUsers.size * 2, 30),
            timestamp: Date.now()
        });
    }
}

function handleGetSignals(userId, data) {
    const { chatZone, gender } = data;
    
    // Check if user got matched while waiting
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            const signals = match.signals[userId] || [];
            
            match.signals[userId] = [];
            
            smartLog('GET-SIGNALS', `${userId.slice(-8)} -> ${signals.length} signals from match ${matchId}`);
            
            // Remove from waiting list if still there
            if (waitingUsers.has(userId)) {
                const user = waitingUsers.get(userId);
                removeUserFromIndexes(userId, user.chatZone);
            }
            
            return createCorsResponse({
                status: 'matched',
                matchId,
                partnerId,
                isInitiator: match.p1 === userId,
                signals,
                partnerInfo: match.userInfo ? match.userInfo[partnerId] : {},
                partnerChatZone: match.chatZones ? match.chatZones[partnerId] : null,
                matchScore: match.matchScore || null,
                message: 'Match found! Start WebRTC connection.',
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
    
    smartLog('SEND-SIGNAL', `${userId.slice(-8)} -> ${partnerId.slice(-8)} (${type})`);
    
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
        const user = waitingUsers.get(userId);
        removeUserFromIndexes(userId, user.chatZone);
        removed = true;
    }
    if (partnerId && waitingUsers.has(partnerId)) {
        const user = waitingUsers.get(partnerId);
        removeUserFromIndexes(partnerId, user.chatZone);
        removed = true;
    }
    
    if (matchId && activeMatches.has(matchId)) {
        activeMatches.delete(matchId);
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
        const user = waitingUsers.get(userId);
        removeUserFromIndexes(userId, user.chatZone);
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
    
    return createCorsResponse({ 
        status: 'disconnected',
        removed,
        timestamp: Date.now()
    });
}

function cleanup() {
    const now = Date.now();
    let cleanedUsers = 0;
    let cleanedMatches = 0;
    
    const expiredUsers = [];
    for (const [userId, user] of waitingUsers.entries()) {
        if (now - user.timestamp > USER_TIMEOUT) {
            expiredUsers.push({ userId, chatZone: user.chatZone });
        }
    }
    
    const expiredMatches = [];
    for (const [matchId, match] of activeMatches.entries()) {
        if (now - match.timestamp > MATCH_LIFETIME) {
            expiredMatches.push(matchId);
        }
    }
    
    expiredUsers.forEach(({ userId, chatZone }) => {
        removeUserFromIndexes(userId, chatZone);
        cleanedUsers++;
    });
    
    expiredMatches.forEach(matchId => {
        activeMatches.delete(matchId);
        cleanedMatches++;
    });
    
    if (waitingUsers.size > MAX_WAITING_USERS) {
        const excess = waitingUsers.size - MAX_WAITING_USERS;
        const oldestUsers = Array.from(waitingUsers.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp)
            .slice(0, excess);
        
        oldestUsers.forEach(([userId, user]) => {
            removeUserFromIndexes(userId, user.chatZone);
            cleanedUsers++;
        });
    }
    
    if (cleanedUsers > 0 || cleanedMatches > 0) {
        criticalLog('CLEANUP', `Removed ${cleanedUsers} users, ${cleanedMatches} matches. Active: ${waitingUsers.size} waiting, ${activeMatches.size} matched`);
    }
}

export default async function handler(req) {
    trackRequest();
    cleanup();
    
    if (req.method === 'OPTIONS') {
        return createCorsResponse(null, 200);
    }
    
    if (req.method === 'GET') {
        const url = new URL(req.url);
        const debug = url.searchParams.get('debug');
        
        if (debug === 'true') {
            return createCorsResponse({
                status: 'double-indexed-webrtc-signaling',
                runtime: 'edge',
                algorithm: 'double-indexed-map',
                stats: {
                    waitingUsers: waitingUsers.size,
                    activeMatches: activeMatches.size,
                    timezoneGroups: timezoneUsers.size,
                    cacheSize: distanceCache.size
                },
                performance: {
                    requestCount,
                    uptime: Date.now() - lastResetTime
                },
                timestamp: Date.now()
            });
        }
        
        return createCorsResponse({ 
            status: 'double-indexed-signaling-ready',
            runtime: 'edge',
            stats: { 
                waiting: waitingUsers.size, 
                matches: activeMatches.size,
                zones: timezoneUsers.size
            },
            message: 'Double-indexed WebRTC signaling server ready',
            timestamp: Date.now()
        });
    }
    
    if (req.method !== 'POST') {
        return createCorsResponse({ error: 'POST required for signaling' }, 405);
    }
    
    try {
        let data;
        let requestBody = '';
        
        try {
            data = await req.json();
        } catch (jsonError) {
            if (!req.body) {
                return createCorsResponse({ 
                    error: 'No request body found',
                    tip: 'Send JSON body with your POST request'
                }, 400);
            }
            
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
                    tip: 'Send JSON data'
                }, 400);
            }
            
            data = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody;
        }
        
        const { action, userId, chatZone } = data;
        
        if (!userId) {
            return createCorsResponse({ 
                error: 'userId is required',
                tip: 'Include userId in your JSON'
            }, 400);
        }
        
        if (!action) {
            return createCorsResponse({ 
                error: 'action is required',
                validActions: ['instant-match', 'get-signals', 'send-signal', 'p2p-connected', 'disconnect']
            }, 400);
        }
        
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
        criticalLog('SERVER ERROR', `Error: ${error.message}`);
        return createCorsResponse({ 
            error: 'Server error', 
            details: error.message,
            timestamp: Date.now()
        }, 500);
    }
}

export const config = { runtime: 'edge' };

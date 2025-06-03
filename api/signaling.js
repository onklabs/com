let waitingUsers = new Map(); // userId -> { userId, timestamp, userInfo }
let activeMatches = new Map(); // matchId -> { p1, p2, signals, timestamp }

const USER_TIMEOUT = 120000; // 2 minutes for waiting users
const MATCH_LIFETIME = 600000; // 10 minutes for active matches
const MAX_WAITING_USERS = 120000; // Prevent memory bloat

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

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return createCorsResponse(null, 200);
  }
  
  // GET: Health check and debug info
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const debug = url.searchParams.get('debug');
    
    if (debug === 'true') {
      return createCorsResponse({
        status: 'webrtc-signaling-server',
        stats: {
          waitingUsers: waitingUsers.size,
          activeMatches: activeMatches.size,
          totalUsers: waitingUsers.size + (activeMatches.size * 2)
        },
        waitingUserIds: Array.from(waitingUsers.keys()),
        activeMatchIds: Array.from(activeMatches.keys()),
        timestamp: Date.now()
      });
    }
    
    // Trigger cleanup
    cleanup();
    
    return createCorsResponse({ 
      status: 'signaling-ready',
      stats: { 
        waiting: waitingUsers.size, 
        matches: activeMatches.size
      },
      message: 'WebRTC signaling server ready for connections',
      timestamp: Date.now()
    });
  }
  
  if (req.method !== 'POST') {
    return createCorsResponse({ error: 'POST required for signaling' }, 405);
  }
  
  try {
    // Parse request body
    const data = await req.json();
    
    const { action, userId } = data;
    
    if (!userId) {
      return createCorsResponse({ error: 'userId is required' }, 400);
    }
    
    console.log(`[${action?.toUpperCase() || 'UNKNOWN'}] ${userId}`);
    
    switch (action) {
      case 'instant-match': 
        return handleInstantMatch(userId, data);
      case 'get-signals': 
        return handleGetSignals(userId);
      case 'send-signal': 
        return handleSendSignal(userId, data);
      case 'disconnect': 
        return handleDisconnect(userId);
      default: 
        return createCorsResponse({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (error) {
    console.error('[SERVER ERROR]', error);
    return createCorsResponse({ error: 'Server error', details: error.message }, 500);
  }
}

// ==========================================
// INSTANT MATCH HANDLER (SIMPLIFIED)
// ==========================================

function handleInstantMatch(userId, data) {
  const { userInfo, preferredMatchId } = data;
  
  console.log(`[INSTANT-MATCH] ${userId} looking for partner`);
  
  // Cleanup first
  cleanup();
  
  // Check if user is already waiting or matched
  if (waitingUsers.has(userId)) {
    waitingUsers.delete(userId);
    console.log(`[INSTANT-MATCH] Updated existing user ${userId}`);
  }
  
  // Remove user from any existing matches
  for (const [matchId, match] of activeMatches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      console.log(`[INSTANT-MATCH] Removing ${userId} from existing match ${matchId}`);
      activeMatches.delete(matchId);
      break;
    }
  }
  
  // Try to find instant match from waiting users
  let bestMatch = null;
  let bestMatchScore = 0;
  
  for (const [waitingUserId, waitingUser] of waitingUsers.entries()) {
    if (waitingUserId === userId) continue;
    
    // Calculate compatibility score
    let score = 1;
    
    // Prefer users with complementary userInfo if available
    if (userInfo && waitingUser.userInfo) {
      if (userInfo.gender && waitingUser.userInfo.gender && 
          userInfo.gender !== waitingUser.userInfo.gender && 
          userInfo.gender !== 'Unspecified' && waitingUser.userInfo.gender !== 'Unspecified') {
        score += 2; // Bonus for different genders
      }
      if (userInfo.status && waitingUser.userInfo.status &&
          userInfo.status === waitingUser.userInfo.status) {
        score += 1; // Bonus for similar status/mood
      }
    }
    
    // Prefer newer users (less waiting time)
    const waitTime = Date.now() - waitingUser.timestamp;
    if (waitTime < 30000) score += 1; // Less than 30 seconds
    if (waitTime < 10000) score += 1; // Less than 10 seconds (very fresh)
    
    if (score > bestMatchScore) {
      bestMatchScore = score;
      bestMatch = { userId: waitingUserId, user: waitingUser };
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
      }
    };
    
    activeMatches.set(matchId, match);
    
    console.log(`[INSTANT-MATCH] 🚀 ${userId} <-> ${partnerId} (${matchId}) - ${isUserInitiator ? 'INITIATOR' : 'RECEIVER'}`);
    
    return createCorsResponse({
      status: 'instant-match',
      matchId,
      partnerId,
      isInitiator: isUserInitiator,
      partnerInfo: partnerUser.userInfo || {},
      signals: [], // No pre-exchanged signals
      compatibility: bestMatchScore,
      message: 'Instant match found! WebRTC connection will be established.',
      timestamp: Date.now()
    });
    
  } else {
    // No immediate match, add to waiting list
    const waitingUser = {
      userId,
      userInfo: userInfo || {},
      timestamp: Date.now()
    };
    
    waitingUsers.set(userId, waitingUser);
    
    const position = waitingUsers.size;
    console.log(`[INSTANT-MATCH] ${userId} added to waiting list (position ${position})`);
    
    return createCorsResponse({
      status: 'waiting',
      position,
      waitingUsers: waitingUsers.size,
      message: 'Added to matching queue. Waiting for partner...',
      estimatedWaitTime: Math.min(waitingUsers.size * 2, 30),
      timestamp: Date.now()
    });
  }
}

// ==========================================
// SIGNAL HANDLERS
// ==========================================

function handleGetSignals(userId) {
  // Find user's match
  for (const [matchId, match] of activeMatches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      const partnerId = match.p1 === userId ? match.p2 : match.p1;
      const signals = match.signals[userId] || [];
      
      // Clear signals after reading to prevent duplicates
      match.signals[userId] = [];
      
      console.log(`[GET-SIGNALS] ${userId} -> ${signals.length} signals from match ${matchId}`);
      
      return createCorsResponse({
        status: 'matched',
        matchId,
        partnerId,
        isInitiator: match.p1 === userId,
        signals,
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
    console.log(`[SEND-SIGNAL] Match ${matchId} not found`);
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
    console.log(`[SEND-SIGNAL] Trimmed signal queue for ${partnerId}`);
  }
  
  console.log(`[SEND-SIGNAL] ${userId} -> ${partnerId} (${type}) in match ${matchId}`);
  
  return createCorsResponse({
    status: 'sent',
    partnerId,
    signalType: type,
    queueLength: match.signals[partnerId].length,
    timestamp: Date.now()
  });
}

function handleDisconnect(userId) {
  console.log(`[DISCONNECT] ${userId}`);
  
  let removed = false;
  
  // Remove from waiting list
  if (waitingUsers.has(userId)) {
    waitingUsers.delete(userId);
    removed = true;
    console.log(`[DISCONNECT] Removed ${userId} from waiting list`);
  }
  
  // Remove from active matches and notify partner
  for (const [matchId, match] of activeMatches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      const partnerId = match.p1 === userId ? match.p2 : match.p1;
      
      // Add disconnect signal to partner's queue
      if (match.signals[partnerId]) {
        match.signals[partnerId].push({
          type: 'disconnect',
          payload: { reason: 'partner_disconnected' },
          from: userId,
          timestamp: Date.now()
        });
      }
      
      console.log(`[DISCONNECT] Removing match ${matchId}, notifying ${partnerId}`);
      
      // Remove match after a delay to let partner receive disconnect signal
      setTimeout(() => {
        activeMatches.delete(matchId);
        console.log(`[DISCONNECT] Match ${matchId} cleaned up`);
      }, 5000);
      
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

// ==========================================
// CLEANUP UTILITIES
// ==========================================

function cleanup() {
  const now = Date.now();
  let cleanedUsers = 0;
  let cleanedMatches = 0;
  
  // Clean expired waiting users
  for (const [userId, user] of waitingUsers.entries()) {
    if (now - user.timestamp > USER_TIMEOUT) {
      waitingUsers.delete(userId);
      cleanedUsers++;
    }
  }
  
  // Clean old matches
  for (const [matchId, match] of activeMatches.entries()) {
    if (now - match.timestamp > MATCH_LIFETIME) {
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
    
    oldestUsers.forEach(([userId]) => {
      waitingUsers.delete(userId);
      cleanedUsers++;
    });
    
    console.log(`[CLEANUP] Removed ${excess} oldest users due to capacity limit`);
  }
  
  if (cleanedUsers > 0 || cleanedMatches > 0) {
    console.log(`[CLEANUP] Removed ${cleanedUsers} expired users, ${cleanedMatches} old matches. Active: ${waitingUsers.size} waiting, ${activeMatches.size} matched`);
  }
}

// Auto-cleanup every 5 minutes
setInterval(cleanup, 300000);

// Edge Runtime configuration
export const config = {
  runtime: 'edge'
};

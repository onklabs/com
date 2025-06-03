// WebRTC Signaling Server - Standard Offer/Answer Exchange
// Synchronized with fixed client that generates fresh signals

let waitingUsers = new Map(); // userId -> { userId, timestamp, userInfo }
let activeMatches = new Map(); // matchId -> { p1, p2, signals, timestamp }

const USER_TIMEOUT = 120000; // 2 minutes for waiting users
const MATCH_LIFETIME = 600000; // 10 minutes for active matches
const MAX_WAITING_USERS = 120000; // Prevent memory bloat

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // GET: Health check and debug info
  if (req.method === 'GET') {
    const { debug } = req.query;
    
    if (debug === 'true') {
      return res.json({
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
    
    return res.json({ 
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
    return res.status(405).json({ error: 'POST required for signaling' });
  }
  
  try {
    // Parse request body
    let data;
    if (typeof req.body === 'string') {
      data = JSON.parse(req.body);
    } else {
      data = req.body;
    }
    
    const { action, userId } = data;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    console.log(`[${action?.toUpperCase() || 'UNKNOWN'}] ${userId}`);
    
    switch (action) {
      case 'instant-match': 
        return handleInstantMatch(userId, data, res);
      case 'get-signals': 
        return handleGetSignals(userId, res);
      case 'send-signal': 
        return handleSendSignal(userId, data, res);
      case 'disconnect': 
        return handleDisconnect(userId, res);
      default: 
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    console.error('[SERVER ERROR]', error);
    return res.status(500).json({ error: 'Server error', details: error.message });
  }
}

// ==========================================
// INSTANT MATCH HANDLER (SIMPLIFIED)
// ==========================================

function handleInstantMatch(userId, data, res) {
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
    
    return res.json({
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
    
    return res.json({
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

function handleGetSignals(userId, res) {
  // Find user's match
  for (const [matchId, match] of activeMatches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      const partnerId = match.p1 === userId ? match.p2 : match.p1;
      const signals = match.signals[userId] || [];
      
      // Clear signals after reading to prevent duplicates
      match.signals[userId] = [];
      
      console.log(`[GET-SIGNALS] ${userId} -> ${signals.length} signals from match ${matchId}`);
      
      return res.json({
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
    return res.json({
      status: 'waiting',
      position,
      waitingUsers: waitingUsers.size,
      timestamp: Date.now()
    });
  }
  
  return res.json({
    status: 'not_found',
    message: 'User not found in waiting list or active matches',
    timestamp: Date.now()
  });
}

function handleSendSignal(userId, data, res) {
  const { matchId, type, payload } = data;
  
  if (!matchId || !type || !payload) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['matchId', 'type', 'payload']
    });
  }
  
  const match = activeMatches.get(matchId);
  if (!match) {
    console.log(`[SEND-SIGNAL] Match ${matchId} not found`);
    return res.status(404).json({ 
      error: 'Match not found',
      matchId,
      availableMatches: Array.from(activeMatches.keys())
    });
  }
  
  if (match.p1 !== userId && match.p2 !== userId) {
    return res.status(403).json({ error: 'User not in this match' });
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
  
  return res.json({
    status: 'sent',
    partnerId,
    signalType: type,
    queueLength: match.signals[partnerId].length,
    timestamp: Date.now()
  });
}

function handleDisconnect(userId, res) {
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
  
  return res.json({ 
    status: 'disconnected',
    removed,
    timestamp: Date.now()
  });
}

// ==========================================
// CLEANUP UTILITIES
// ==========================================

function cleanup() {
  return;
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

// Instant Match Server - Pre-generated Offer/Answer Exchange
// Revolutionary approach: Send offer/answer with first request for instant matching!

let waitingUsers = new Map(); // userId -> { userId, offer, answer, timestamp, userInfo }
let activeMatches = new Map(); // matchId -> { p1, p2, signals, timestamp }

const USER_TIMEOUT = 120000; // 2 minutes for waiting users
const MATCH_LIFETIME = 600000; // 10 minutes for active matches
const MAX_WAITING_USERS = 1000; // Prevent memory bloat

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
        status: 'instant-match-server',
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
      status: 'instant-match-ready',
      stats: { 
        waiting: waitingUsers.size, 
        matches: activeMatches.size
      },
      message: 'Send POST with userId + pre-generated offer/answer for instant matching',
      timestamp: Date.now()
    });
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST required for instant matching' });
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
// INSTANT MATCH HANDLER
// ==========================================

function handleInstantMatch(userId, data, res) {
  const { offer, userInfo, preferredMatchId } = data;
  
  console.log(`[INSTANT-MATCH] ${userId} with pre-generated offer`);
  
  // Validate required data - only offer needed now
  if (!offer) {
    return res.status(400).json({ 
      error: 'Pre-generated offer is required for instant matching',
      required: ['userId', 'offer']
    });
  }
  
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
    
    // Calculate compatibility score (can be enhanced with preferences)
    let score = 1;
    
    // Prefer users with similar userInfo if available
    if (userInfo && waitingUser.userInfo) {
      if (userInfo.gender && waitingUser.userInfo.gender && 
          userInfo.gender !== waitingUser.userInfo.gender) {
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
    
    // Create match with pre-generated matchId
    const matchId = preferredMatchId || `instant_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Determine who is initiator (consistent ordering)
    const isUserInitiator = userId < partnerId;
    const p1 = isUserInitiator ? userId : partnerId;
    const p2 = isUserInitiator ? partnerId : userId;
    
    // Create match with pre-exchanged signals
    const match = {
      p1,
      p2,
      timestamp: Date.now(),
      signals: {
        [p1]: [], // Initiator gets partner's answer
        [p2]: []  // Receiver gets partner's offer
      },
      preExchanged: true,
      userInfo: {
        [userId]: userInfo || {},
        [partnerId]: partnerUser.userInfo || {}
      }
    };
    
    // Pre-populate signals for instant connection
    if (isUserInitiator) {
      // User is initiator, partner gets user's offer (will create real answer)
      match.signals[partnerId].push({
        type: 'offer', 
        payload: offer,
        from: userId,
        timestamp: Date.now(),
        preGenerated: true
      });
    } else {
      // Partner is initiator, user gets partner's offer (will create real answer)
      match.signals[userId].push({
        type: 'offer',
        payload: partnerUser.offer,
        from: partnerId,
        timestamp: Date.now(),
        preGenerated: true
      });
    }
    
    activeMatches.set(matchId, match);
    
    console.log(`[INSTANT-MATCH] 🚀 ${userId} <-> ${partnerId} (${matchId}) - PRE-EXCHANGED!`);
    
    return res.json({
      status: 'instant-match',
      matchId,
      partnerId,
      isInitiator: isUserInitiator,
      partnerInfo: partnerUser.userInfo || {},
      signals: match.signals[userId] || [],
      preExchanged: true,
      compatibility: bestMatchScore,
      message: 'Instant match with pre-exchanged offer/answer!',
      timestamp: Date.now()
    });
    
  } else {
    // No immediate match, add to waiting list
    const waitingUser = {
      userId,
      offer,
      userInfo: userInfo || {},
      timestamp: Date.now()
    };
    
    waitingUsers.set(userId, waitingUser);
    
    console.log(`[INSTANT-MATCH] ${userId} added to waiting list (${waitingUsers.size} waiting)`);
    
    return res.json({
      status: 'waiting',
      position: waitingUsers.size,
      waitingUsers: waitingUsers.size,
      message: 'Added to instant match queue with pre-generated offer only',
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
      
      // Clear signals after reading
      match.signals[userId] = [];
      
      console.log(`[GET-SIGNALS] ${userId} -> ${signals.length} signals from match ${matchId}`);
      
      return res.json({
        status: 'matched',
        matchId,
        partnerId,
        isInitiator: match.p1 === userId,
        signals,
        preExchanged: match.preExchanged || false,
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
    return res.status(403).json({ error: 'User not in match' });
  }
  
  const partnerId = match.p1 === userId ? match.p2 : match.p1;
  
  // Add signal to partner's queue
  match.signals[partnerId] = match.signals[partnerId] || [];
  match.signals[partnerId].push({
    type,
    payload,
    from: userId,
    timestamp: Date.now()
  });
  
  // Limit signals
  if (match.signals[partnerId].length > 50) {
    match.signals[partnerId] = match.signals[partnerId].slice(-50);
  }
  
  console.log(`[SEND-SIGNAL] ${userId} -> ${partnerId} (${type}) in match ${matchId}`);
  
  return res.json({
    status: 'sent',
    partnerId,
    queueLength: match.signals[partnerId].length,
    timestamp: Date.now()
  });
}

function handleDisconnect(userId, res) {
  console.log(`[DISCONNECT] ${userId}`);
  
  // Remove from waiting list
  waitingUsers.delete(userId);
  
  // Remove from active matches
  for (const [matchId, match] of activeMatches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      console.log(`[DISCONNECT] Removing match ${matchId}`);
      activeMatches.delete(matchId);
      break;
    }
  }
  
  return res.json({ 
    status: 'disconnected',
    timestamp: Date.now()
  });
}

// ==========================================
// CLEANUP
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
  
  // Prevent memory bloat
  if (waitingUsers.size > MAX_WAITING_USERS) {
    const excess = waitingUsers.size - MAX_WAITING_USERS;
    const oldestUsers = Array.from(waitingUsers.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, excess);
    
    oldestUsers.forEach(([userId]) => {
      waitingUsers.delete(userId);
      cleanedUsers++;
    });
  }
  
  if (cleanedUsers > 0 || cleanedMatches > 0) {
    console.log(`[CLEANUP] Removed ${cleanedUsers} expired users, ${cleanedMatches} old matches. Active: ${waitingUsers.size} waiting, ${activeMatches.size} matched`);
  }
}
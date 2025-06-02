// Bulletproof WebRTC Signaling Server - Fixes "Match not found" permanently
// Key fixes: Longer match lifetime, activity tracking, gradual cleanup

let queue = [];
let matches = new Map();
let userLastSeen = new Map();

// FIXED: Much longer timeouts and better cleanup logic
const MATCH_LIFETIME = 900000; // 15 minutes (was 5 minutes)
const MIN_MATCH_LIFETIME = 300000; // 5 minutes minimum (was 2 minutes)
const USER_ACTIVITY_TIMEOUT = 180000; // 3 minutes user inactivity
const CLEANUP_INTERVAL = 60000; // Clean every 1 minute (not every request)

function matchByUserId(userId) {
  for (const [matchId, match] of matches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      return { matchId, match };
    }
  }
  return null;
}

function trackUserActivity(userId) {
  userLastSeen.set(userId, Date.now());
}

function isUserActive(userId) {
  const lastSeen = userLastSeen.get(userId);
  if (!lastSeen) return false;
  return (Date.now() - lastSeen) < USER_ACTIVITY_TIMEOUT;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    console.log('[CORS] Preflight request handled');
    return res.status(200).end();
  }
  
  // GET: polling and health check
  if (req.method === 'GET') {
    const { userId, debug } = req.query;
    
    if (debug === 'true') {
      return res.json({
        status: 'debug',
        stats: {
          queue: queue.length,
          matches: matches.size,
          activeUsers: userLastSeen.size,
          totalUsers: queue.length + (matches.size * 2)
        },
        queueUserIds: queue,
        matchIds: Array.from(matches.keys()),
        userActivity: Object.fromEntries(
          Array.from(userLastSeen.entries()).map(([uid, time]) => [
            uid,
            { lastSeen: time, isActive: isUserActive(uid) }
          ])
        ),
        timestamp: Date.now()
      });
    }
    
    if (!userId) {
      // Trigger cleanup but don't block response
      setTimeout(gradualCleanup, 100);
      
      return res.json({ 
        status: 'online', 
        stats: { 
          waiting: queue.length, 
          matches: matches.size,
          totalUsers: queue.length + (matches.size * 2)
        },
        queueUserIds: queue,
        matchIds: Array.from(matches.keys()),
        timestamp: Date.now()
      });
    }
    
    return handlePoll(userId, res);
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'GET for polling, POST for actions' });
  }
  
  try {
    // Parse request body - handle both formats
    let data;
    if (typeof req.body === 'string') {
      data = JSON.parse(req.body);
    } else {
      data = req.body;
    }
    
    const { action, userId } = data;
    
    if (!userId) {
      console.log('[ERROR] No userId provided in request');
      return res.status(400).json({ error: 'userId is required' });
    }
    
    // Track user activity for every request
    trackUserActivity(userId);
    
    console.log(`[${action.toUpperCase()}] ${userId} - Active users: ${userLastSeen.size}, Matches: ${matches.size}`);
    
    switch (action) {
      case 'join-queue': 
        return handleJoin(userId, res);
      case 'send-signal': 
        return handleSend(userId, data, res);
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
// HANDLERS
// ==========================================

function handlePoll(userId, res) {
  trackUserActivity(userId);
  
  const found = matchByUserId(userId);
  if (found) {
    const { matchId, match } = found;
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    const signals = match.signals[userId] || [];
    match.signals[userId] = []; // Clear after reading

    // FIXED: Update match activity when polling
    match.lastActivity = Date.now();
    match.pollCount = (match.pollCount || 0) + 1;

    console.log(`[POLL] ${userId} -> match ${matchId}, ${signals.length} signals, polls: ${match.pollCount}, age: ${Date.now() - match.ts}ms`);

    return res.json({
      status: 'matched',
      matchId,
      partnerId,
      isInitiator: match.p1 === userId,
      signals,
      matchAge: Date.now() - match.ts,
      pollCount: match.pollCount,
      timestamp: Date.now()
    });
  }

  const pos = queue.findIndex(id => id === userId);
  if (pos !== -1) {
    console.log(`[POLL] ${userId} -> queue position ${pos + 1}`);
    return res.json({
      status: 'waiting',
      position: pos + 1,
      queueSize: queue.length,
      estimatedWait: Math.min((pos + 1) * 3, 30),
      timestamp: Date.now()
    });
  }

  console.log(`[POLL] ${userId} -> not found, will rejoin queue on next action`);
  return res.json({
    status: 'not_found',
    action_needed: 'join-queue',
    timestamp: Date.now()
  });
}

function handleJoin(userId, res) {
  trackUserActivity(userId);
  
  // Check existing match first - FIXED: Don't create duplicate matches
  const existing = matchByUserId(userId);
  if (existing) {
    const { matchId, match } = existing;
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    const signals = match.signals[userId] || [];
    match.signals[userId] = []; // Clear after reading
    
    // Update activity
    match.lastActivity = Date.now();
    
    console.log(`[JOIN] ${userId} -> existing match ${matchId} (age: ${Date.now() - match.ts}ms)`);
    
    return res.json({
      status: 'matched',
      matchId,
      partnerId,
      isInitiator: match.p1 === userId,
      signals,
      matchAge: Date.now() - match.ts,
      timestamp: Date.now()
    });
  }
  
  // Remove from queue if already present
  queue = queue.filter(id => id !== userId);
  
  // Try to match with someone in queue
  if (queue.length > 0) {
    const partnerId = queue.shift();
    
    // FIXED: Ensure both users are still active
    if (!isUserActive(partnerId)) {
      console.log(`[JOIN] Partner ${partnerId} inactive, removing from queue`);
      // Try next person in queue
      if (queue.length > 0) {
        return handleJoin(userId, res);
      } else {
        // No one else, add to queue
        queue.push(userId);
        return res.json({
          status: 'queued',
          position: 1,
          timestamp: Date.now()
        });
      }
    }
    
    const matchId = `m_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    
    // Consistent ordering: smaller userId is p1 (initiator)
    const p1 = userId < partnerId ? userId : partnerId;
    const p2 = userId < partnerId ? partnerId : userId;
    
    const match = {
      p1, 
      p2, 
      ts: Date.now(),
      lastActivity: Date.now(),
      createdBy: userId,
      signals: { [p1]: [], [p2]: [] },
      pollCount: 0,
      signalCount: 0,
      // FIXED: Prevent premature cleanup
      protected: true, // Protect from cleanup for first 5 minutes
      protectedUntil: Date.now() + MIN_MATCH_LIFETIME
    };
    
    matches.set(matchId, match);
    
    console.log(`[MATCHED] ${p1} <-> ${p2} (${matchId}) - Protected until: ${new Date(match.protectedUntil).toISOString()}`);
    
    return res.json({
      status: 'matched',
      matchId,
      partnerId,
      isInitiator: userId === p1,
      signals: [],
      matchAge: 0,
      timestamp: Date.now()
    });
  }
  
  // Add to queue
  if (!queue.includes(userId)) {
    queue.push(userId);
  }
  
  console.log(`[QUEUE] ${userId} -> position ${queue.length} (total waiting: ${queue.length})`);
  
  return res.json({
    status: 'queued',
    position: queue.length,
    queueSize: queue.length,
    estimatedWait: Math.min(queue.length * 3, 30),
    timestamp: Date.now()
  });
}

function handleSend(userId, data, res) {
  const { matchId, type, payload } = data;
  
  trackUserActivity(userId);
  
  console.log(`[SEND] ${userId} attempting to send ${type} to match ${matchId}`);
  
  const match = matches.get(matchId);
  if (!match) {
    console.log(`[SEND ERROR] Match ${matchId} not found`);
    console.log(`[SEND ERROR] Available matches: [${Array.from(matches.keys()).join(', ')}]`);
    
    // FIXED: More helpful error message
    const userMatch = matchByUserId(userId);
    if (userMatch) {
      console.log(`[SEND ERROR] User ${userId} has different match: ${userMatch.matchId}`);
      return res.status(409).json({ 
        error: 'Match ID mismatch',
        requestedMatch: matchId,
        currentMatch: userMatch.matchId,
        message: 'Please poll for latest match ID'
      });
    }
    
    return res.status(404).json({ 
      error: 'Match not found',
      requestedMatch: matchId,
      availableMatches: Array.from(matches.keys()),
      message: 'Match may have expired, please rejoin queue'
    });
  }
  
  if (match.p1 !== userId && match.p2 !== userId) {
    console.log(`[SEND ERROR] User ${userId} not in match ${matchId} (p1: ${match.p1}, p2: ${match.p2})`);
    return res.status(403).json({ 
      error: 'User not in match',
      userId,
      matchUsers: [match.p1, match.p2]
    });
  }
  
  const partnerId = match.p1 === userId ? match.p2 : match.p1;
  
  // FIXED: Update activity and signal count
  match.lastActivity = Date.now();
  match.signalCount = (match.signalCount || 0) + 1;
  
  // Add signal to partner's queue
  match.signals[partnerId] = match.signals[partnerId] || [];
  match.signals[partnerId].push({ 
    type, 
    payload, 
    from: userId, 
    ts: Date.now(),
    id: match.signalCount
  });
  
  // FIXED: Higher limit for signals and better management
  if (match.signals[partnerId].length > 100) {
    // Keep only recent signals
    match.signals[partnerId] = match.signals[partnerId].slice(-50);
  }
  
  console.log(`[SEND] ${userId} -> ${partnerId} (${type}) - Signal #${match.signalCount}, Queue: ${match.signals[partnerId].length}, Age: ${Date.now() - match.ts}ms`);
  
  return res.json({
    status: 'sent',
    partnerId,
    signalId: match.signalCount,
    queueLength: match.signals[partnerId].length,
    matchAge: Date.now() - match.ts,
    timestamp: Date.now()
  });
}

function handleDisconnect(userId, res) {
  console.log(`[DISCONNECT] ${userId}`);
  
  trackUserActivity(userId);
  
  // Remove from queue
  const queuePos = queue.indexOf(userId);
  if (queuePos !== -1) {
    queue.splice(queuePos, 1);
    console.log(`[DISCONNECT] Removed ${userId} from queue`);
  }
  
  // Remove from matches
  for (const [matchId, match] of matches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      console.log(`[DISCONNECT] Removing match ${matchId} (age: ${Date.now() - match.ts}ms)`);
      matches.delete(matchId);
      break;
    }
  }
  
  // Clean up user activity tracking
  userLastSeen.delete(userId);
  
  return res.json({ 
    status: 'disconnected',
    timestamp: Date.now()
  });
}

// ==========================================
// FIXED: GRADUAL CLEANUP - NO MORE AGGRESSIVE DELETION
// ==========================================

function gradualCleanup() {
  const now = Date.now();
  let cleaned = 0;
  const before = matches.size;

  console.log(`[CLEANUP] Starting cleanup - ${matches.size} matches, ${userLastSeen.size} users tracked`);

  for (const [matchId, match] of matches.entries()) {
    const age = now - match.ts;
    const timeSinceActivity = now - (match.lastActivity || match.ts);
    const isProtected = match.protected && now < match.protectedUntil;
    
    // FIXED: Much more conservative cleanup logic
    let shouldCleanup = false;
    let reason = '';
    
    if (isProtected) {
      // Never clean protected matches
      continue;
    } else if (age > MATCH_LIFETIME) {
      // Very old matches (15+ minutes)
      shouldCleanup = true;
      reason = `too old (${Math.round(age/60000)}min)`;
    } else if (age > MIN_MATCH_LIFETIME) {
      // Only clean older matches if BOTH users are inactive
      const p1Active = isUserActive(match.p1);
      const p2Active = isUserActive(match.p2);
      
      if (!p1Active && !p2Active && timeSinceActivity > USER_ACTIVITY_TIMEOUT) {
        shouldCleanup = true;
        reason = `both users inactive (${Math.round(timeSinceActivity/60000)}min)`;
      } else if (timeSinceActivity > USER_ACTIVITY_TIMEOUT * 2) {
        // Very long inactivity
        shouldCleanup = true;
        reason = `very long inactivity (${Math.round(timeSinceActivity/60000)}min)`;
      }
    }
    
    if (shouldCleanup) {
      console.log(`[CLEANUP] Removing match ${matchId} - ${reason} (age: ${Math.round(age/60000)}min, signals: ${match.signalCount || 0})`);
      matches.delete(matchId);
      cleaned++;
    }
  }
  
  // Clean up inactive users from tracking
  let usersCleared = 0;
  for (const [userId, lastSeen] of userLastSeen.entries()) {
    if (now - lastSeen > USER_ACTIVITY_TIMEOUT * 2) {
      userLastSeen.delete(userId);
      usersCleared++;
    }
  }

  if (cleaned > 0 || usersCleared > 0) {
    console.log(`[CLEANUP] Complete - Removed ${cleaned} matches (${before} -> ${matches.size}), ${usersCleared} inactive users. Active users: ${userLastSeen.size}`);
  }
}

// FIXED: Schedule regular cleanup instead of cleanup on every request
setInterval(gradualCleanup, CLEANUP_INTERVAL);
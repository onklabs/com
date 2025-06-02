// Optimized In-Memory Signaling Server for Vercel
// Real WebRTC connections, no demo mode

// Global state storage optimized for Vercel's memory constraints
const globalState = {
  queue: [], // Array of user objects {id, joinedAt}
  matches: new Map(), // matchId -> {id, p1, p2, status, signals, createdAt}
  userMatches: new Map(), // userId -> matchId  
  lastActivity: new Map(), // userId -> timestamp
  connectionStates: new Map(), // userId -> connection state
  stats: { totalMatches: 0, activeConnections: 0 }
};

const CONFIG = {
  MATCH_TIMEOUT: 180000, // 3 minutes (shorter for Vercel)
  CLEANUP_INTERVAL: 15000, // 15 seconds
  MAX_SIGNALS_PER_USER: 8, // Reduced for memory efficiency
  INACTIVE_TIMEOUT: 60000, // 1 minute
  MAX_QUEUE_SIZE: 50 // Prevent memory overflow
};

// Single cleanup interval
let cleanupInterval;
if (!cleanupInterval) {
  cleanupInterval = setInterval(performCleanup, CONFIG.CLEANUP_INTERVAL);
}

export default async function handler(req, res) {
  // Simplified CORS - no OPTIONS handling
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  const { method, query, body } = req;
  
  try {
    if (method === 'GET') {
      return handlePoll(query.userId, res);
    }
    
    if (method === 'POST') {
      const data = typeof body === 'string' ? JSON.parse(body) : body;
      const { action, userId } = data;
      
      if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
      }
      
      // Update activity immediately
      updateUserActivity(userId);
      
      switch (action) {
        case 'join-queue':
          return handleJoinQueue(userId, res);
        case 'signal':
          return handleSignal(userId, data, res);
        case 'ready':
          return handleReady(userId, res);
        case 'disconnect':
          return handleDisconnect(userId, res);
        default:
          return res.status(400).json({ error: 'Invalid action' });
      }
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('[SERVER ERROR]', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ==========================================
// CORE HANDLERS
// ==========================================

function handlePoll(userId, res) {
  if (!userId) {
    return res.json({ 
      status: 'server_info', 
      stats: {
        waiting: globalState.queue.length,
        activeMatches: globalState.matches.size,
        totalUsers: globalState.lastActivity.size
      }
    });
  }

  updateUserActivity(userId);
  
  // Check if user has active match
  const matchId = globalState.userMatches.get(userId);
  
  if (matchId && globalState.matches.has(matchId)) {
    const match = globalState.matches.get(matchId);
    const partnerId = getPartnerId(match, userId);
    
    // Get pending signals for this user
    const signals = getAndClearUserSignals(matchId, userId);
    
    console.log(`[POLL] ${userId} -> match ${matchId}, ${signals.length} signals`);
    
    return res.json({
      status: match.status,
      matchId,
      partnerId,
      isInitiator: match.p1 === userId,
      signals,
      timestamp: Date.now()
    });
  }
  
  // Check queue position
  const queueIndex = globalState.queue.findIndex(user => user.id === userId);
  
  if (queueIndex !== -1) {
    console.log(`[POLL] ${userId} -> queue position ${queueIndex + 1}`);
    
    return res.json({
      status: 'waiting',
      position: queueIndex + 1,
      estimatedWait: Math.min(queueIndex * 2, 30)
    });
  }
  
  console.log(`[POLL] ${userId} -> not found`);
  return res.json({ status: 'not_found' });
}

function handleJoinQueue(userId, res) {
  // Clean up any existing state for this user
  cleanupUser(userId);
  
  // Check queue size limit
  if (globalState.queue.length >= CONFIG.MAX_QUEUE_SIZE) {
    return res.status(503).json({ error: 'Server busy, try again later' });
  }
  
  // Try immediate matching
  if (globalState.queue.length > 0) {
    const partner = globalState.queue.shift();
    const matchId = createMatch(userId, partner.id);
    
    console.log(`[INSTANT MATCH] ${userId} <-> ${partner.id}`);
    
    return res.json({
      status: 'matched',
      matchId,
      partnerId: partner.id,
      isInitiator: true,
      signals: [],
      timestamp: Date.now()
    });
  }
  
  // Add to queue
  globalState.queue.push({
    id: userId,
    joinedAt: Date.now()
  });
  
  console.log(`[QUEUE] ${userId} -> position 1`);
  
  return res.json({
    status: 'queued',
    position: 1,
    estimatedWait: 30
  });
}

function handleSignal(userId, data, res) {
  const { matchId, type, signal } = data;
  
  if (!matchId || !globalState.matches.has(matchId)) {
    return res.status(404).json({ error: 'Match not found' });
  }
  
  const match = globalState.matches.get(matchId);
  
  if (!isUserInMatch(match, userId)) {
    return res.status(403).json({ error: 'Not in this match' });
  }
  
  // Store signal for partner
  addSignalToMatch(matchId, userId, { type, signal, timestamp: Date.now() });
  
  console.log(`[SIGNAL] ${userId} -> ${type} in match ${matchId}`);
  
  return res.json({
    status: 'signal_sent',
    matchId,
    timestamp: Date.now()
  });
}

function handleReady(userId, res) {
  const matchId = globalState.userMatches.get(userId);
  
  if (!matchId || !globalState.matches.has(matchId)) {
    return res.status(404).json({ error: 'No active match' });
  }
  
  const match = globalState.matches.get(matchId);
  match.status = 'connected';
  globalState.matches.set(matchId, match);
  
  globalState.stats.activeConnections++;
  
  console.log(`[READY] ${userId} -> match ${matchId} connected`);
  
  // Schedule cleanup after successful connection
  setTimeout(() => {
    if (globalState.matches.has(matchId)) {
      cleanupMatch(matchId);
    }
  }, 300000); // 5 minutes max connection time
  
  return res.json({
    status: 'connected',
    partnerId: getPartnerId(match, userId),
    timestamp: Date.now()
  });
}

function handleDisconnect(userId, res) {
  console.log(`[DISCONNECT] ${userId}`);
  
  const matchId = globalState.userMatches.get(userId);
  if (matchId) {
    // Notify partner
    const match = globalState.matches.get(matchId);
    if (match) {
      const partnerId = getPartnerId(match, userId);
      addSignalToMatch(matchId, userId, { 
        type: 'disconnect', 
        signal: null, 
        timestamp: Date.now() 
      });
    }
    
    cleanupMatch(matchId);
  }
  
  cleanupUser(userId);
  
  return res.json({ status: 'disconnected' });
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

function createMatch(user1Id, user2Id) {
  const matchId = `m_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
  
  const match = {
    id: matchId,
    p1: user1Id,
    p2: user2Id,
    status: 'matched',
    signals: new Map(), // userId -> signals array
    createdAt: Date.now()
  };
  
  // Initialize signal storage
  match.signals.set(user1Id, []);
  match.signals.set(user2Id, []);
  
  globalState.matches.set(matchId, match);
  globalState.userMatches.set(user1Id, matchId);
  globalState.userMatches.set(user2Id, matchId);
  
  globalState.stats.totalMatches++;
  
  return matchId;
}

function addSignalToMatch(matchId, fromUserId, signalData) {
  const match = globalState.matches.get(matchId);
  if (!match) return;
  
  const partnerId = getPartnerId(match, fromUserId);
  let partnerSignals = match.signals.get(partnerId) || [];
  
  partnerSignals.push(signalData);
  
  // Keep only recent signals to prevent memory bloat
  if (partnerSignals.length > CONFIG.MAX_SIGNALS_PER_USER) {
    partnerSignals = partnerSignals.slice(-CONFIG.MAX_SIGNALS_PER_USER);
  }
  
  match.signals.set(partnerId, partnerSignals);
  globalState.matches.set(matchId, match);
}

function getAndClearUserSignals(matchId, userId) {
  const match = globalState.matches.get(matchId);
  if (!match) return [];
  
  const signals = match.signals.get(userId) || [];
  match.signals.set(userId, []); // Clear after reading
  globalState.matches.set(matchId, match);
  
  return signals;
}

function getPartnerId(match, userId) {
  return match.p1 === userId ? match.p2 : match.p1;
}

function isUserInMatch(match, userId) {
  return match.p1 === userId || match.p2 === userId;
}

function updateUserActivity(userId) {
  globalState.lastActivity.set(userId, Date.now());
}

function cleanupUser(userId) {
  // Remove from queue
  const queueIndex = globalState.queue.findIndex(user => user.id === userId);
  if (queueIndex !== -1) {
    globalState.queue.splice(queueIndex, 1);
  }
  
  // Clean up user data
  globalState.userMatches.delete(userId);
  globalState.lastActivity.delete(userId);
  globalState.connectionStates.delete(userId);
}

function cleanupMatch(matchId) {
  const match = globalState.matches.get(matchId);
  if (!match) return;
  
  console.log(`[CLEANUP] Match ${matchId}`);
  
  globalState.matches.delete(matchId);
  globalState.userMatches.delete(match.p1);
  globalState.userMatches.delete(match.p2);
  
  // Remove from queue if still there
  globalState.queue = globalState.queue.filter(user => 
    user.id !== match.p1 && user.id !== match.p2
  );
  
  if (globalState.stats.activeConnections > 0) {
    globalState.stats.activeConnections--;
  }
}

function performCleanup() {
  const now = Date.now();
  let cleanedItems = 0;
  
  try {
    // Clean up old matches
    for (const [matchId, match] of globalState.matches.entries()) {
      if (now - match.createdAt > CONFIG.MATCH_TIMEOUT) {
        cleanupMatch(matchId);
        cleanedItems++;
      }
    }
    
    // Clean up inactive users
    for (const [userId, lastActivity] of globalState.lastActivity.entries()) {
      if (now - lastActivity > CONFIG.INACTIVE_TIMEOUT) {
        const matchId = globalState.userMatches.get(userId);
        if (matchId) {
          cleanupMatch(matchId);
        }
        cleanupUser(userId);
        cleanedItems++;
      }
    }
    
    // Clean up old queue entries
    globalState.queue = globalState.queue.filter(user => 
      now - user.joinedAt < CONFIG.INACTIVE_TIMEOUT
    );
    
    if (cleanedItems > 0) {
      console.log(`[CLEANUP] Removed ${cleanedItems} items, Active: ${globalState.lastActivity.size}, Queue: ${globalState.queue.length}, Matches: ${globalState.matches.size}`);
    }
    
  } catch (error) {
    console.error('[CLEANUP ERROR]', error);
  }
}
// In-Memory Signaling Server - No Redis Required
// Persistent state management with proper cleanup

// Global state storage
const globalState = {
  queue: [], // Array of user IDs waiting for match
  matches: new Map(), // matchId -> match data
  userMatches: new Map(), // userId -> matchId  
  userSignals: new Map(), // userId -> signals array
  lastActivity: new Map(), // userId -> timestamp
  stats: { totalMatches: 0, activeUsers: 0 }
};

const CONFIG = {
  MATCH_TIMEOUT: 300000, // 5 minutes
  CLEANUP_INTERVAL: 30000, // 30 seconds
  MAX_SIGNALS: 15,
  POLL_TIMEOUT: 2000 // 2 seconds for long polling
};

// Cleanup interval
let cleanupInterval;
if (!cleanupInterval) {
  cleanupInterval = setInterval(() => {
    performCleanup();
  }, CONFIG.CLEANUP_INTERVAL);
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method === 'GET') {
    const { userId } = req.query;
    if (!userId) {
      return res.json({ 
        status: 'online', 
        stats: {
          waiting: globalState.queue.length,
          matches: globalState.matches.size,
          activeUsers: globalState.lastActivity.size
        }
      });
    }
    return handlePoll(userId, res);
  }
  
  if (req.method === 'POST') {
    try {
      const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { action, userId } = data;
      
      if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
      }
      
      // Update activity
      globalState.lastActivity.set(userId, Date.now());
      
      switch (action) {
        case 'join-queue':
          return handleJoin(userId, res);
        case 'send-signal':
          return handleSend(userId, data, res);
        case 'disconnect':
          return handleDisconnect(userId, res);
        default:
          return res.status(400).json({ error: 'Unknown action' });
      }
    } catch (error) {
      console.error('[ERROR]', error.message);
      return res.status(500).json({ error: 'Server error' });
    }
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}

function handlePoll(userId, res) {
  try {
    // Update activity
    globalState.lastActivity.set(userId, Date.now());
    
    // Check if user has active match
    const matchId = globalState.userMatches.get(userId);
    
    if (matchId && globalState.matches.has(matchId)) {
      const match = globalState.matches.get(matchId);
      const partnerId = match.p1 === userId ? match.p2 : match.p1;
      
      // Get user's signals
      const signals = globalState.userSignals.get(userId) || [];
      
      // Clear signals after reading
      globalState.userSignals.delete(userId);
      
      const ready = signals.some(s => s.type === 'ready') || match.status === 'connected';
      
      // Auto cleanup when both users are ready
      if (ready && match.status !== 'connected') {
        match.status = 'connected';
        globalState.matches.set(matchId, match);
        
        // Schedule cleanup after connection
        setTimeout(() => {
          cleanupMatch(matchId);
        }, 10000); // 10 seconds after connection
      }
      
      console.log(`[POLL] ${userId} -> matched with ${partnerId}, signals: ${signals.length}`);
      
      return res.json({
        status: ready ? 'connected' : 'matched',
        matchId: ready ? undefined : matchId,
        partnerId,
        isInitiator: match.p1 === userId,
        signals,
        connectionReady: ready
      });
    }
    
    // Check queue position
    const queuePosition = globalState.queue.indexOf(userId);
    
    if (queuePosition !== -1) {
      console.log(`[POLL] ${userId} -> waiting in queue, position: ${queuePosition + 1}`);
      
      return res.json({
        status: 'waiting',
        position: queuePosition + 1,
        estimatedWait: Math.min((queuePosition + 1) * 3, 60)
      });
    }
    
    console.log(`[POLL] ${userId} -> not found`);
    
    return res.json({ 
      status: 'not_found', 
      action_needed: 'join-queue' 
    });
    
  } catch (error) {
    console.error('[POLL ERROR]', error);
    return res.status(500).json({ error: 'Poll failed' });
  }
}

function handleJoin(userId, res) {
  try {
    // Check if user already has a match
    const existingMatchId = globalState.userMatches.get(userId);
    
    if (existingMatchId && globalState.matches.has(existingMatchId)) {
      const match = globalState.matches.get(existingMatchId);
      const partnerId = match.p1 === userId ? match.p2 : match.p1;
      
      const signals = globalState.userSignals.get(userId) || [];
      globalState.userSignals.delete(userId);
      
      console.log(`[JOIN] ${userId} -> returning existing match with ${partnerId}`);
      
      return res.json({
        status: 'matched',
        matchId: existingMatchId,
        partnerId,
        isInitiator: match.p1 === userId,
        signals,
        connectionReady: signals.some(s => s.type === 'ready')
      });
    }
    
    // Remove user from queue if already there
    const queueIndex = globalState.queue.indexOf(userId);
    if (queueIndex !== -1) {
      globalState.queue.splice(queueIndex, 1);
    }
    
    // Try to match with someone in queue
    if (globalState.queue.length > 0) {
      const partnerId = globalState.queue.shift(); // Get first person in queue
      
      // Create match
      const matchId = generateMatchId();
      const p1 = userId < partnerId ? userId : partnerId;
      const p2 = userId < partnerId ? partnerId : userId;
      
      const match = {
        id: matchId,
        p1,
        p2,
        status: 'signaling',
        createdAt: Date.now()
      };
      
      // Store match data
      globalState.matches.set(matchId, match);
      globalState.userMatches.set(p1, matchId);
      globalState.userMatches.set(p2, matchId);
      
      // Initialize signal arrays
      globalState.userSignals.set(p1, []);
      globalState.userSignals.set(p2, []);
      
      globalState.stats.totalMatches++;
      
      console.log(`[MATCHED] ${p1} <-> ${p2} (${matchId})`);
      
      return res.json({
        status: 'matched',
        matchId,
        partnerId,
        isInitiator: userId === p1,
        signals: [],
        connectionReady: false
      });
    }
    
    // Add to queue
    if (!globalState.queue.includes(userId)) {
      globalState.queue.push(userId);
    }
    
    const position = globalState.queue.indexOf(userId) + 1;
    
    console.log(`[QUEUED] ${userId} -> position ${position}`);
    
    return res.json({
      status: 'queued',
      position,
      estimatedWait: Math.min(position * 3, 60)
    });
    
  } catch (error) {
    console.error('[JOIN ERROR]', error);
    return res.status(500).json({ error: 'Join failed' });
  }
}

function handleSend(userId, data, res) {
  try {
    const { matchId, type, payload } = data;
    
    if (!globalState.matches.has(matchId)) {
      return res.status(404).json({ error: 'Match not found' });
    }
    
    const match = globalState.matches.get(matchId);
    
    if (match.p1 !== userId && match.p2 !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    
    // Create signal
    const signal = {
      type,
      payload,
      from: userId,
      timestamp: Date.now()
    };
    
    // Add signal to partner's queue
    let partnerSignals = globalState.userSignals.get(partnerId) || [];
    partnerSignals.push(signal);
    
    // Keep only recent signals
    if (partnerSignals.length > CONFIG.MAX_SIGNALS) {
      partnerSignals = partnerSignals.slice(-CONFIG.MAX_SIGNALS);
    }
    
    globalState.userSignals.set(partnerId, partnerSignals);
    
    // Update match status if ready signal
    if (type === 'ready') {
      match.status = 'connected';
      globalState.matches.set(matchId, match);
    }
    
    // Get my signals
    const mySignals = globalState.userSignals.get(userId) || [];
    globalState.userSignals.delete(userId); // Clear after reading
    
    const ready = mySignals.some(s => s.type === 'ready') || match.status === 'connected';
    
    console.log(`[SEND] ${userId} -> ${partnerId} (${type}), ready: ${ready}`);
    
    return res.json({
      status: ready ? 'connected' : 'sent',
      matchId: ready ? undefined : matchId,
      partnerId,
      signals: mySignals,
      connectionReady: ready
    });
    
  } catch (error) {
    console.error('[SEND ERROR]', error);
    return res.status(500).json({ error: 'Send failed' });
  }
}

function handleDisconnect(userId, res) {
  try {
    // Remove from queue
    const queueIndex = globalState.queue.indexOf(userId);
    if (queueIndex !== -1) {
      globalState.queue.splice(queueIndex, 1);
    }
    
    // Clean up match
    const matchId = globalState.userMatches.get(userId);
    if (matchId) {
      cleanupMatch(matchId);
    }
    
    // Clean up user data
    globalState.userMatches.delete(userId);
    globalState.userSignals.delete(userId);
    globalState.lastActivity.delete(userId);
    
    console.log(`[DISCONNECT] ${userId}`);
    
    return res.json({ status: 'disconnected' });
    
  } catch (error) {
    console.error('[DISCONNECT ERROR]', error);
    return res.status(500).json({ error: 'Disconnect failed' });
  }
}

function cleanupMatch(matchId) {
  try {
    const match = globalState.matches.get(matchId);
    if (!match) return;
    
    console.log(`[CLEANUP] Removing match ${matchId}`);
    
    // Clean up all related data
    globalState.matches.delete(matchId);
    globalState.userMatches.delete(match.p1);
    globalState.userMatches.delete(match.p2);
    globalState.userSignals.delete(match.p1);
    globalState.userSignals.delete(match.p2);
    
    // Remove from queue if still there
    const p1Index = globalState.queue.indexOf(match.p1);
    const p2Index = globalState.queue.indexOf(match.p2);
    
    if (p1Index !== -1) globalState.queue.splice(p1Index, 1);
    if (p2Index !== -1) globalState.queue.splice(p2Index, 1);
    
  } catch (error) {
    console.error('[CLEANUP ERROR]', error);
  }
}

function performCleanup() {
  try {
    const now = Date.now();
    
    // Clean up old matches
    for (const [matchId, match] of globalState.matches.entries()) {
      if (now - match.createdAt > CONFIG.MATCH_TIMEOUT) {
        cleanupMatch(matchId);
      }
    }
    
    // Clean up inactive users
    for (const [userId, lastActivity] of globalState.lastActivity.entries()) {
      if (now - lastActivity > CONFIG.MATCH_TIMEOUT) {
        const queueIndex = globalState.queue.indexOf(userId);
        if (queueIndex !== -1) {
          globalState.queue.splice(queueIndex, 1);
        }
        
        const matchId = globalState.userMatches.get(userId);
        if (matchId) {
          cleanupMatch(matchId);
        }
        
        globalState.userMatches.delete(userId);
        globalState.userSignals.delete(userId);
        globalState.lastActivity.delete(userId);
        
        console.log(`[CLEANUP] Removed inactive user ${userId}`);
      }
    }
    
    // Update stats
    globalState.stats.activeUsers = globalState.lastActivity.size;
    
    console.log(`[CLEANUP] Active: ${globalState.stats.activeUsers}, Queue: ${globalState.queue.length}, Matches: ${globalState.matches.size}`);
    
  } catch (error) {
    console.error('[CLEANUP ERROR]', error);
  }
}

function generateMatchId() {
  return `m_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}
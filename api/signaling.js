// Debug WebRTC Signaling Server - Log everything
// Minimal version to debug the 404 errors

let queue = [];
let matches = new Map();
let requestLog = [];

function logRequest(req, action, result) {
  const entry = {
    timestamp: Date.now(),
    method: req.method,
    action: action || 'unknown',
    userId: req.body?.userId || req.query?.userId || 'anonymous',
    url: req.url,
    result: result || 'pending',
    queue: [...queue],
    matches: Array.from(matches.keys())
  };
  requestLog.push(entry);
  
  // Keep only last 50 logs
  if (requestLog.length > 50) {
    requestLog = requestLog.slice(-50);
  }
  
  console.log('[DEBUG LOG]', JSON.stringify(entry, null, 2));
}

function matchByUserId(userId) {
  for (const [matchId, match] of matches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      return { matchId, match };
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    logRequest(req, 'options', 'success');
    return res.status(200).end();
  }
  
  // GET: polling and debug info
  if (req.method === 'GET') {
    const { userId, debug } = req.query;
    
    if (debug === 'true') {
      logRequest(req, 'debug', 'logs');
      return res.json({
        status: 'debug',
        requestLog: requestLog.slice(-20), // Last 20 requests
        currentState: {
          queue,
          matches: Array.from(matches.entries()),
          timestamp: Date.now()
        }
      });
    }
    
    if (!userId) {
      logRequest(req, 'health', 'online');
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
    
    logRequest(req, 'poll', `user:${userId}`);
    return handlePoll(userId, res);
  }
  
  if (req.method !== 'POST') {
    logRequest(req, 'invalid-method', `method:${req.method}`);
    return res.status(405).json({ error: 'GET for polling, POST for actions' });
  }
  
  try {
    // Handle both application/json and text/plain
    let data;
    if (typeof req.body === 'string') {
      data = JSON.parse(req.body);
    } else {
      data = req.body;
    }
    
    const { action, userId } = data;
    
    if (!userId) {
      logRequest(req, action, 'error:no-userId');
      return res.status(400).json({ error: 'userId is required' });
    }
    
    logRequest(req, action, `user:${userId}`);
    
    switch (action) {
      case 'join-queue': 
        return handleJoin(userId, res);
      case 'send-signal': 
        return handleSend(userId, data, res);
      case 'disconnect': 
        return handleDisconnect(userId, res);
      default: 
        logRequest(req, 'unknown-action', `action:${action}`);
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    logRequest(req, 'server-error', error.message);
    console.error('[SERVER ERROR]', error);
    return res.status(500).json({ error: 'Server error', details: error.message });
  }
}

// ==========================================
// HANDLERS
// ==========================================

function handlePoll(userId, res) {
  const found = matchByUserId(userId);
  if (found) {
    const { matchId, match } = found;
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    const signals = match.signals[userId] || [];
    match.signals[userId] = []; // Clear after reading

    console.log(`[POLL] ${userId} -> match ${matchId}, ${signals.length} signals`);

    return res.json({
      status: 'matched',
      matchId,
      partnerId,
      isInitiator: match.p1 === userId,
      signals,
      timestamp: Date.now()
    });
  }

  const pos = queue.findIndex(id => id === userId);
  if (pos !== -1) {
    console.log(`[POLL] ${userId} -> queue position ${pos + 1}`);
    return res.json({
      status: 'waiting',
      position: pos + 1,
      timestamp: Date.now()
    });
  }

  console.log(`[POLL] ${userId} -> not found`);
  return res.json({
    status: 'not_found',
    timestamp: Date.now()
  });
}

function handleJoin(userId, res) {
  // Check existing match first
  const found = matchByUserId(userId);
  if (found) {
    const { matchId, match } = found;
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    const signals = match.signals[userId] || [];
    match.signals[userId] = []; // Clear after reading
    
    console.log(`[JOIN] ${userId} -> existing match ${matchId}`);
    
    return res.json({
      status: 'matched',
      matchId,
      partnerId,
      isInitiator: match.p1 === userId,
      signals,
      timestamp: Date.now()
    });
  }
  
  // Remove from queue if present
  queue = queue.filter(id => id !== userId);
  
  // Try to match with someone in queue
  if (queue.length > 0) {
    const partnerId = queue.shift();
    const matchId = `m_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Consistent ordering: smaller userId is p1 (initiator)
    const p1 = userId < partnerId ? userId : partnerId;
    const p2 = userId < partnerId ? partnerId : userId;
    
    const match = {
      p1, 
      p2, 
      ts: Date.now(),
      signals: { [p1]: [], [p2]: [] }
    };
    
    matches.set(matchId, match);
    
    console.log(`[MATCHED] ${p1} <-> ${p2} (${matchId})`);
    
    return res.json({
      status: 'matched',
      matchId,
      partnerId,
      isInitiator: userId === p1,
      signals: [],
      timestamp: Date.now()
    });
  }
  
  // Add to queue
  if (!queue.includes(userId)) {
    queue.push(userId);
  }
  
  console.log(`[QUEUE] ${userId} -> position ${queue.length}`);
  
  return res.json({
    status: 'queued',
    position: queue.length,
    timestamp: Date.now()
  });
}

function handleSend(userId, data, res) {
  const { matchId, type, payload } = data;
  
  console.log(`[SEND] ${userId} trying to send ${type} to match ${matchId}`);
  console.log(`[SEND] Available matches:`, Array.from(matches.keys()));
  
  const match = matches.get(matchId);
  if (!match) {
    console.log(`[SEND ERROR] Match ${matchId} not found`);
    console.log(`[SEND ERROR] Available matches:`, Array.from(matches.keys()));
    console.log(`[SEND ERROR] Match details:`, Array.from(matches.entries()));
    
    return res.status(404).json({ 
      error: 'Match not found',
      requestedMatch: matchId,
      availableMatches: Array.from(matches.keys()),
      userMatches: Array.from(matches.entries()).filter(([id, m]) => m.p1 === userId || m.p2 === userId)
    });
  }
  
  if (match.p1 !== userId && match.p2 !== userId) {
    console.log(`[SEND ERROR] User ${userId} not in match ${matchId} (p1: ${match.p1}, p2: ${match.p2})`);
    return res.status(403).json({ 
      error: 'Unauthorized',
      userId,
      matchUsers: [match.p1, match.p2]
    });
  }
  
  const partnerId = match.p1 === userId ? match.p2 : match.p1;
  
  // Add signal to partner's queue
  match.signals[partnerId] = match.signals[partnerId] || [];
  match.signals[partnerId].push({ 
    type, 
    payload, 
    from: userId, 
    ts: Date.now() 
  });
  
  // Limit signals to prevent memory bloat
  if (match.signals[partnerId].length > 20) {
    match.signals[partnerId] = match.signals[partnerId].slice(-20);
  }
  
  console.log(`[SEND] ${userId} -> ${partnerId} (${type}) - ${match.signals[partnerId].length} signals queued`);
  
  return res.json({
    status: 'sent',
    partnerId,
    timestamp: Date.now()
  });
}

function handleDisconnect(userId, res) {
  console.log(`[DISCONNECT] ${userId}`);
  
  // Remove from queue
  queue = queue.filter(id => id !== userId);
  
  // Remove from matches
  for (const [matchId, match] of matches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      console.log(`[DISCONNECT] Removing match ${matchId}`);
      matches.delete(matchId);
      break;
    }
  }
  
  return res.json({ 
    status: 'disconnected',
    timestamp: Date.now()
  });
}
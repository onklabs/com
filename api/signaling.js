// Minimal WebRTC Signaling - Follow 7 Request Flow
// Flow: join → offer → answer → ready (7 requests total)

let queue = [];
let matches = new Map();
const MATCH_TIMEOUT = 300000; // 5 minutes

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // GET: polling and health with detailed info
  if (req.method === 'GET') {
    const { userId } = req.query;
    if (!userId) {
      return res.json({ 
        status: 'online', 
        stats: { 
          waiting: queue.length, 
          matches: matches.size,
          totalUsers: queue.length + (matches.size * 2)
        },
        queueUserIds: queue, // All user IDs in queue
        matchIds: Array.from(matches.keys()), // All active match IDs
        timestamp: Date.now()
      });
    }
    return handlePoll(userId, res);
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'GET for polling, POST for actions' });
  }
  
  try {
    // Handle both application/json and text/plain to avoid OPTIONS
    const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { action, userId } = data;
    
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    
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
    return res.status(500).json({ error: 'Server error' });
  }
}

// ==========================================
// HANDLERS
// ==========================================

function handlePoll(userId, res) {
  cleanup();
  
  // Check active match
  for (const [matchId, match] of matches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      const partnerId = match.p1 === userId ? match.p2 : match.p1;
      const signals = match.signals[userId] || [];
      match.signals[userId] = []; // Clear after reading
      
      const ready = signals.some(s => s.type === 'ready') || match.status === 'connected';
      
      // Schedule cleanup for successful connections
      if (ready && !match.cleanup) {
        match.cleanup = true;
        match.status = 'connected';
        setTimeout(() => {
          console.log(`[CLEANUP] Removing connected match ${matchId}`);
          matches.delete(matchId);
        }, 30000); // 15 seconds after connection
      }
      
      console.log(`[POLL] ${userId} -> match ${matchId}, ${signals.length} signals, ready: ${ready}`);
      
      return res.json({
        status: ready ? 'connected' : 'matched',
        matchId: ready ? undefined : matchId,
        partnerId,
        isInitiator: match.p1 === userId,
        signals,
        connectionReady: ready,
        timestamp: Date.now()
      });
    }
  }
  
  // Check queue position
  const pos = queue.findIndex(id => id === userId);
  if (pos !== -1) {
    console.log(`[POLL] ${userId} -> queue position ${pos + 1}`);
    
    return res.json({
      status: 'waiting',
      position: pos + 1,
      estimatedWait: Math.min((pos + 1) * 5, 60),
      queueAhead: queue.slice(0, pos),
      timestamp: Date.now()
    });
  }
  
  console.log(`[POLL] ${userId} -> not found`);
  return res.json({ 
    status: 'not_found', 
    action_needed: 'join-queue',
    timestamp: Date.now()
  });
}

function handleJoin(userId, res) {
  cleanup();
  
  // Check existing match first
  for (const [matchId, match] of matches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
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
        connectionReady: signals.some(s => s.type === 'ready'),
        queueUserIds: queue,
        matchIds: Array.from(matches.keys()),
        timestamp: Date.now()
      });
    }
  }
  
  // Remove from queue if present
  queue = queue.filter(id => id !== userId);
  
  // Try to match with someone in queue
  if (queue.length > 0) {
    const partnerId = queue.shift();
    const matchId = `m_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Consistent ordering: smaller userId is p1
    const p1 = userId < partnerId ? userId : partnerId;
    const p2 = userId < partnerId ? partnerId : userId;
    
    const match = {
      p1, 
      p2, 
      ts: Date.now(),
      status: 'signaling',
      signals: { [p1]: [], [p2]: [] },
      cleanup: false
    };
    
    matches.set(matchId, match);
    
    console.log(`[MATCHED] ${p1} <-> ${p2} (${matchId})`);
    
    return res.json({
      status: 'matched',
      matchId,
      partnerId,
      isInitiator: userId === p1,
      signals: [],
      connectionReady: false,
      queueUserIds: queue,
      matchIds: Array.from(matches.keys()),
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
    estimatedWait: Math.min(queue.length * 5, 60),
    queueUserIds: queue,
    matchIds: Array.from(matches.keys()),
    timestamp: Date.now()
  });
}

function handleSend(userId, data, res) {
  const { matchId, type, payload } = data;
  
  const match = matches.get(matchId);
  if (!match) {
    console.log(`[SEND ERROR] Match ${matchId} not found`);
    return res.status(404).json({ error: 'Match not found' });
  }
  
  if (match.p1 !== userId && match.p2 !== userId) {
    console.log(`[SEND ERROR] User ${userId} not in match ${matchId}`);
    return res.status(403).json({ error: 'Unauthorized' });
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
  
  // Update match status if ready signal
  if (type === 'ready') {
    match.status = 'connected';
  }
  
  // Get my pending signals
  const mySignals = match.signals[userId] || [];
  match.signals[userId] = []; // Clear after reading
  
  const ready = mySignals.some(s => s.type === 'ready') || match.status === 'connected';
  
  // Schedule cleanup for successful connections
  if (ready && !match.cleanup) {
    match.cleanup = true;
    setTimeout(() => {
      console.log(`[CLEANUP] Removing connected match ${matchId}`);
      matches.delete(matchId);
    }, 30000);
  }
  
  console.log(`[SEND] ${userId} -> ${partnerId} (${type}), ready: ${ready}`);
  
  return res.json({
    status: ready ? 'connected' : 'sent',
    matchId: ready ? undefined : matchId,
    partnerId,
    signals: mySignals,
    connectionReady: ready,
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

// ==========================================
// CLEANUP
// ==========================================

function cleanup() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [matchId, match] of matches.entries()) {
    if (now - match.ts > MATCH_TIMEOUT) {
      matches.delete(matchId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[CLEANUP] Removed ${cleaned} old matches. Active: queue=${queue.length}, matches=${matches.size}`);
  }
}
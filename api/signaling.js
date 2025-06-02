// Fixed WebRTC Signaling - Extended Match Lifetime
// Flow: join → offer → answer → ready (7 requests total)

let queue = [];
let matches = new Map();
const MATCH_TIMEOUT = 600000; // 10 minutes (increased from 5)
const MIN_MATCH_LIFETIME = 120000; // Keep matches alive for at least 2 minutes

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
    const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { action, userId } = data;
    
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
  console.log(`[POLL] ${userId} polling...`);
  cleanup();

  const found = matchByUserId(userId);
  if (found) {
    const { matchId, match } = found;
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    const signals = match.signals[userId] || [];
    match.signals[userId] = []; // Clear after reading

    // Update last activity to prevent premature cleanup
    match.lastActivity = Date.now();

    const ready = signals.some(s => s.type === 'ready') || match.status === 'connected';

    console.log(`[POLL] ${userId} -> match ${matchId}, ${signals.length} signals, ready: ${ready}, age: ${Date.now() - match.ts}ms`);

    return res.json({
      status: ready ? 'connected' : 'matched',
      matchId: ready ? undefined : matchId,
      partnerId,
      isInitiator: match.p1 === userId,
      signals,
      connectionReady: ready,
      matchAge: Date.now() - match.ts,
      timestamp: Date.now()
    });
  }

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
      
      // Update activity
      match.lastActivity = Date.now();
      
      console.log(`[JOIN] ${userId} -> existing match ${matchId} (age: ${Date.now() - match.ts}ms)`);
      
      return res.json({
        status: 'matched',
        matchId,
        partnerId,
        isInitiator: match.p1 === userId,
        signals,
        connectionReady: signals.some(s => s.type === 'ready'),
        matchAge: Date.now() - match.ts,
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
      lastActivity: Date.now(), // Track last activity
      status: 'signaling',
      signals: { [p1]: [], [p2]: [] },
      cleanup: false,
      iceCount: 0 // Track ICE candidates
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
      matchAge: 0,
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
    console.log(`[SEND ERROR] Match ${matchId} not found (available: ${Array.from(matches.keys()).join(', ')})`);
    return res.status(404).json({ error: 'Match not found' });
  }
  
  if (match.p1 !== userId && match.p2 !== userId) {
    console.log(`[SEND ERROR] User ${userId} not in match ${matchId}`);
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  const partnerId = match.p1 === userId ? match.p2 : match.p1;
  
  // Update activity timestamp
  match.lastActivity = Date.now();
  
  // Add signal to partner's queue
  match.signals[partnerId] = match.signals[partnerId] || [];
  match.signals[partnerId].push({ 
    type, 
    payload, 
    from: userId, 
    ts: Date.now() 
  });
  
  // Track ICE candidates
  if (type === 'ice-candidate') {
    match.iceCount = (match.iceCount || 0) + 1;
  }
  
  // Limit signals to prevent memory bloat
  if (match.signals[partnerId].length > 50) {
    match.signals[partnerId] = match.signals[partnerId].slice(-50);
  }
  
  // Update match status if ready signal
  if (type === 'ready') {
    match.status = 'connected';
    // Schedule cleanup for successful connections (but keep longer)
    if (!match.cleanup) {
      match.cleanup = true;
      setTimeout(() => {
        console.log(`[CLEANUP] Removing connected match ${matchId} after success`);
        matches.delete(matchId);
      }, 300000); // 5 minutes after connection success
    }
  }
  
  // Get my pending signals
  const mySignals = match.signals[userId] || [];
  match.signals[userId] = []; // Clear after reading
  
  const ready = mySignals.some(s => s.type === 'ready') || match.status === 'connected';
  
  console.log(`[SEND] ${userId} -> ${partnerId} (${type}), ready: ${ready}, ICE count: ${match.iceCount}, age: ${Date.now() - match.ts}ms`);
  
  return res.json({
    status: ready ? 'connected' : 'sent',
    matchId: ready ? undefined : matchId,
    partnerId,
    signals: mySignals,
    connectionReady: ready,
    matchAge: Date.now() - match.ts,
    iceCount: match.iceCount,
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
      console.log(`[DISCONNECT] Removing match ${matchId} (age: ${Date.now() - match.ts}ms)`);
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
// IMPROVED CLEANUP
// ==========================================

function cleanup() {
  const now = Date.now();
  let cleaned = 0;

  for (const [matchId, match] of matches.entries()) {
    const age = now - match.ts;
    const timeSinceActivity = now - (match.lastActivity || match.ts);
    
    // Keep matches alive longer, especially if there's recent activity
    let shouldCleanup = false;
    
    if (match.status === 'connected' && match.cleanup) {
      // Already marked for cleanup after connection success
      continue;
    } else if (age > MATCH_TIMEOUT) {
      // Very old matches
      shouldCleanup = true;
    } else if (age > MIN_MATCH_LIFETIME && timeSinceActivity > 60000) {
      // Old matches with no recent activity
      shouldCleanup = true;
    } else if (age > MIN_MATCH_LIFETIME && (match.iceCount || 0) === 0) {
      // Old matches with no ICE candidates (likely stuck)
      shouldCleanup = true;
    }
    
    if (shouldCleanup) {
      console.log(`[CLEANUP] Removing match ${matchId} - age: ${age}ms, inactive: ${timeSinceActivity}ms, ICE: ${match.iceCount || 0}`);
      matches.delete(matchId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[CLEANUP] Removed ${cleaned} expired matches. Active matches: ${matches.size}`);
  }
}
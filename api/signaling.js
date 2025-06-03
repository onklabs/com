// Improved WebRTC Signaling Server
// Fixed: Race conditions, memory leaks, proper signal types

let queue = [];
let matches = new Map();
let userSessions = new Map(); // Track active sessions
let iceBuffer = new Map(); // matchId -> { p1: [candidates], p2: [candidates] }
const MATCH_TIMEOUT = 300000; // 5 minutes
const CLEANUP_INTERVAL = 60000; // 1 minute
const MAX_SIGNALS_PER_USER = 50;
const MAX_ICE_PER_USER = 100; // ICE candidates can be many
const RATE_LIMIT = new Map(); // userId -> { count, resetTime }

// Valid WebRTC signal types (excluding ICE - handled separately)
const VALID_SIGNAL_TYPES = [
  'offer', 'answer', 'ice-gathering-complete',
  'connection-state-change', 'ready', 'error', 'close'
];

// Start cleanup interval
setInterval(cleanup, CLEANUP_INTERVAL);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'GET') {
    const { userId } = req.query;
    if (!userId) {
      return res.json({ 
        status: 'online', 
        stats: { 
          waiting: queue.length, 
          matches: matches.size,
          sessions: userSessions.size
        },
        timestamp: Date.now()
      });
    }
    return handlePoll(userId, res);
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { action, userId } = data;
    
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'Valid userId required' });
    }
    
    // Rate limiting
    if (!checkRateLimit(userId)) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    
    // Update user session
    userSessions.set(userId, Date.now());
    
    switch (action) {
      case 'join-queue': 
        return handleJoin(userId, res);
      case 'send-signal': 
        return handleSend(userId, data, res);
      case 'send-ice': 
        return handleSendIce(userId, data, res);
      case 'get-ice': 
        return handleGetIce(userId, data, res);
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
// RATE LIMITING
// ==========================================

function checkRateLimit(userId) {
  const now = Date.now();
  const limit = RATE_LIMIT.get(userId);
  
  if (!limit || now > limit.resetTime) {
    RATE_LIMIT.set(userId, { count: 1, resetTime: now + 60000 }); // 1 minute window
    return true;
  }
  
  if (limit.count >= 60) { // 60 requests per minute
    return false;
  }
  
  limit.count++;
  return true;
}

// ==========================================
// HANDLERS
// ==========================================

function handlePoll(userId, res) {
  cleanup();
  
  // Update session timestamp
  userSessions.set(userId, Date.now());
  
  // Check active match
  const matchInfo = findUserMatch(userId);
  if (matchInfo) {
    const { matchId, match } = matchInfo;
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    const signals = match.signals[userId] || [];
    
    // Clear signals after reading (atomic operation)
    match.signals[userId] = [];
    
    const isReady = match.status === 'connected' || 
                   signals.some(s => s.type === 'ready');
    
    console.log(`[POLL] ${userId} -> match ${matchId}, ${signals.length} signals`);
    
    return res.json({
      status: isReady ? 'connected' : 'matched',
      matchId: isReady ? undefined : matchId,
      partnerId,
      isInitiator: match.p1 === userId,
      signals,
      connectionReady: isReady,
      timestamp: Date.now()
    });
  }
  
  // Check queue position
  const queuePosition = queue.findIndex(id => id === userId);
  if (queuePosition !== -1) {
    return res.json({
      status: 'waiting',
      position: queuePosition + 1,
      estimatedWait: Math.min((queuePosition + 1) * 5, 60),
      timestamp: Date.now()
    });
  }
  
  return res.json({ 
    status: 'not_found', 
    action_needed: 'join-queue',
    timestamp: Date.now()
  });
}

function handleJoin(userId, res) {
  cleanup();
  
  // Check if user already has an active match
  const existingMatch = findUserMatch(userId);
  if (existingMatch) {
    const { matchId, match } = existingMatch;
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    
    return res.json({
      status: 'matched',
      matchId,
      partnerId,
      isInitiator: match.p1 === userId,
      signals: match.signals[userId] || [],
      connectionReady: match.status === 'connected',
      timestamp: Date.now()
    });
  }
  
  // Remove user from queue if present (prevent duplicates)
  queue = queue.filter(id => id !== userId);
  
  // Atomic matching operation
  if (queue.length > 0) {
    const partnerId = queue.shift();
    const matchId = createMatch(userId, partnerId);
    
    console.log(`[MATCHED] ${userId} <-> ${partnerId} (${matchId})`);
    
    const match = matches.get(matchId);
    return res.json({
      status: 'matched',
      matchId,
      partnerId,
      isInitiator: match.p1 === userId,
      signals: [],
      connectionReady: false,
      timestamp: Date.now()
    });
  }
  
  // Add to queue
  queue.push(userId);
  
  console.log(`[QUEUE] ${userId} -> position ${queue.length}`);
  
  return res.json({
    status: 'queued',
    position: queue.length,
    estimatedWait: Math.min(queue.length * 5, 60),
    timestamp: Date.now()
  });
}

function handleSend(userId, data, res) {
  const { matchId, type, payload } = data;
  
  // Validate signal type
  if (!VALID_SIGNAL_TYPES.includes(type)) {
    return res.status(400).json({ error: `Invalid signal type: ${type}. Use send-ice for ICE candidates.` });
  }
  
  const match = matches.get(matchId);
  if (!match) {
    return res.status(404).json({ error: 'Match not found or expired' });
  }
  
  if (match.p1 !== userId && match.p2 !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  const partnerId = match.p1 === userId ? match.p2 : match.p1;
  
  // Add signal to partner's queue with size limit
  if (!match.signals[partnerId]) {
    match.signals[partnerId] = [];
  }
  
  match.signals[partnerId].push({ 
    type, 
    payload, 
    from: userId, 
    timestamp: Date.now() 
  });
  
  // Enforce signal queue limit
  if (match.signals[partnerId].length > MAX_SIGNALS_PER_USER) {
    match.signals[partnerId] = match.signals[partnerId].slice(-MAX_SIGNALS_PER_USER);
  }
  
  // Update match status
  if (type === 'ready') {
    match.status = 'connected';
    match.connectedAt = Date.now();
  } else if (type === 'error' || type === 'close') {
    match.status = 'failed';
  }
  
  // Get user's pending signals and ICE candidates
  const mySignals = match.signals[userId] || [];
  const myIceCandidates = getIceCandidates(matchId, userId);
  match.signals[userId] = [];
  
  const connectionReady = match.status === 'connected';
  
  console.log(`[SIGNAL] ${userId} -> ${partnerId}: ${type}`);
  
  return res.json({
    status: connectionReady ? 'connected' : 'signaling',
    matchId: connectionReady ? undefined : matchId,
    partnerId,
    signals: mySignals,
    iceCandidates: myIceCandidates,
    connectionReady,
    timestamp: Date.now()
  });
}

function handleSendIce(userId, data, res) {
  const { matchId, candidate, sdpMLineIndex, sdpMid } = data;
  
  if (!matchId || !candidate) {
    return res.status(400).json({ error: 'Missing matchId or candidate' });
  }
  
  const match = matches.get(matchId);
  if (!match) {
    return res.status(404).json({ error: 'Match not found or expired' });
  }
  
  if (match.p1 !== userId && match.p2 !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  const partnerId = match.p1 === userId ? match.p2 : match.p1;
  
  // Initialize ICE buffer if needed
  if (!iceBuffer.has(matchId)) {
    iceBuffer.set(matchId, { [match.p1]: [], [match.p2]: [] });
  }
  
  const iceData = iceBuffer.get(matchId);
  
  // Add ICE candidate to partner's buffer
  if (!iceData[partnerId]) {
    iceData[partnerId] = [];
  }
  
  iceData[partnerId].push({
    candidate,
    sdpMLineIndex,
    sdpMid,
    from: userId,
    timestamp: Date.now()
  });
  
  // Enforce ICE buffer limit
  if (iceData[partnerId].length > MAX_ICE_PER_USER) {
    iceData[partnerId] = iceData[partnerId].slice(-MAX_ICE_PER_USER);
  }
  
  console.log(`[ICE] ${userId} -> ${partnerId}: candidate sent`);
  
  return res.json({
    status: 'ice-sent',
    matchId,
    partnerId,
    timestamp: Date.now()
  });
}

function handleGetIce(userId, data, res) {
  const { matchId } = data;
  
  if (!matchId) {
    return res.status(400).json({ error: 'Missing matchId' });
  }
  
  const match = matches.get(matchId);
  if (!match) {
    return res.status(404).json({ error: 'Match not found or expired' });
  }
  
  if (match.p1 !== userId && match.p2 !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  // Get ICE candidates for this user
  const iceCandidates = getIceCandidates(matchId, userId);
  
  console.log(`[GET-ICE] ${userId}: ${iceCandidates.length} candidates`);
  
  return res.json({
    status: 'ice-retrieved',
    matchId,
    iceCandidates,
    timestamp: Date.now()
  });
}

function handleDisconnect(userId, res) {
  console.log(`[DISCONNECT] ${userId}`);
  
  // Remove from queue
  queue = queue.filter(id => id !== userId);
  
  // Remove from matches and notify partner
  const matchInfo = findUserMatch(userId);
  if (matchInfo) {
    const { matchId, match } = matchInfo;
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    
    // Add disconnect signal for partner
    if (!match.signals[partnerId]) {
      match.signals[partnerId] = [];
    }
    match.signals[partnerId].push({
      type: 'close',
      payload: { reason: 'partner_disconnected' },
      from: userId,
      timestamp: Date.now()
    });
    
    // Clean up match after delay to allow partner to receive disconnect signal
    setTimeout(() => {
      matches.delete(matchId);
      iceBuffer.delete(matchId); // Clean ICE buffer too
      console.log(`[CLEANUP] Removed match ${matchId} after disconnect`);
    }, 5000);
  }
  
  // Remove user session
  userSessions.delete(userId);
  
  return res.json({ 
    status: 'disconnected',
    timestamp: Date.now()
  });
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function findUserMatch(userId) {
  for (const [matchId, match] of matches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      return { matchId, match };
    }
  }
  return null;
}

function createMatch(userId1, userId2) {
  const matchId = `m_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  
  // Consistent ordering for deterministic initiator
  const p1 = userId1 < userId2 ? userId1 : userId2;
  const p2 = userId1 < userId2 ? userId2 : userId1;
  
  const match = {
    p1, 
    p2, 
    createdAt: Date.now(),
    status: 'signaling',
    signals: { [p1]: [], [p2]: [] }
  };
  
  matches.set(matchId, match);
  
  // Initialize ICE buffer for this match
  iceBuffer.set(matchId, { [p1]: [], [p2]: [] });
  
  return matchId;
}

function getIceCandidates(matchId, userId) {
  if (!iceBuffer.has(matchId)) {
    return [];
  }
  
  const iceData = iceBuffer.get(matchId);
  const candidates = iceData[userId] || [];
  
  // Clear after reading
  iceData[userId] = [];
  
  return candidates;
}

// ==========================================
// CLEANUP
// ==========================================

function cleanup() {
  const now = Date.now();
  let cleanedMatches = 0;
  let cleanedSessions = 0;
  
  // Clean old matches
  for (const [matchId, match] of matches.entries()) {
    const age = now - match.createdAt;
    const shouldCleanup = age > MATCH_TIMEOUT || 
                         (match.status === 'connected' && match.connectedAt && 
                          now - match.connectedAt > 120000); // 2 minutes after connection
    
    if (shouldCleanup) {
      matches.delete(matchId);
      iceBuffer.delete(matchId); // Clean ICE buffer
      cleanedMatches++;
    }
  }
  
  // Clean inactive user sessions (remove from queue if inactive)
  for (const [userId, lastSeen] of userSessions.entries()) {
    if (now - lastSeen > 180000) { // 3 minutes inactive
      userSessions.delete(userId);
      queue = queue.filter(id => id !== userId);
      cleanedSessions++;
    }
  }
  
  // Clean rate limit data
  for (const [userId, limit] of RATE_LIMIT.entries()) {
    if (now > limit.resetTime) {
      RATE_LIMIT.delete(userId);
    }
  }
  
  if (cleanedMatches > 0 || cleanedSessions > 0) {
    console.log(`[CLEANUP] Matches: ${cleanedMatches}, Sessions: ${cleanedSessions}. Active: queue=${queue.length}, matches=${matches.size}`);
  }
}
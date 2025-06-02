// Senior Dev: Minimal WebRTC Signaling - Trust Client, Keep Simple
// Flow: join ? offer ? answer ? ready (7 requests total)

let queue = [];
let matches = new Map();
const MATCH_TIMEOUT = 300000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // GET: polling and health
  if (req.method === 'GET') {
    const { userId } = req.query;
    if (!userId) {
      return res.json({ status: 'online', stats: { waiting: queue.length, matches: matches.size } });
    }
    return handlePoll(userId, res);
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'GET for polling, POST for actions' });
  }
  
  try {
    const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { action, userId } = data;
    
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    
    switch (action) {
      case 'join-queue': return handleJoin(userId, res);
      case 'send-signal': return handleSend(userId, data, res);
      case 'disconnect': return handleDisconnect(userId, res);
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Server error' });
  }
}

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
        setTimeout(() => matches.delete(matchId), 15000);
      }
      
      return res.json({
        status: ready ? 'connected' : 'matched',
        matchId: ready ? undefined : matchId,
        partnerId,
        isInitiator: match.p1 === userId,
        signals,
        connectionReady: ready
      });
    }
  }
  
  // Check queue position
  const pos = queue.findIndex(id => id === userId);
  if (pos !== -1) {
    return res.json({
      status: 'waiting',
      position: pos + 1,
      estimatedWait: Math.min((pos + 1) * 5, 60)
    });
  }
  
  return res.json({ status: 'not_found', action_needed: 'join-queue' });
}

function handleJoin(userId, res) {
  cleanup();
  
  // Check existing match
  for (const [matchId, match] of matches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      const partnerId = match.p1 === userId ? match.p2 : match.p1;
      const signals = match.signals[userId] || [];
      match.signals[userId] = [];
      
      return res.json({
        status: 'matched',
        matchId,
        partnerId,
        isInitiator: match.p1 === userId,
        signals,
        connectionReady: signals.some(s => s.type === 'ready')
      });
    }
  }
  
  // Remove from queue if present
  queue = queue.filter(id => id !== userId);
  
  // Try to match
  if (queue.length > 0) {
    const partnerId = queue.shift();
    const matchId = `m_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const p1 = userId < partnerId ? userId : partnerId;
    const p2 = userId < partnerId ? partnerId : userId;
    
    matches.set(matchId, {
      p1, p2, ts: Date.now(),
      signals: { [p1]: [], [p2]: [] }
    });
    
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
  queue.push(userId);
  return res.json({
    status: 'queued',
    position: queue.length,
    estimatedWait: Math.min(queue.length * 5, 60)
  });
}

function handleSend(userId, data, res) {
  const { matchId, type, payload } = data;
  
  const match = matches.get(matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.p1 !== userId && match.p2 !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  const partnerId = match.p1 === userId ? match.p2 : match.p1;
  
  // Add signal to partner's queue
  match.signals[partnerId] = match.signals[partnerId] || [];
  match.signals[partnerId].push({ type, payload, from: userId, ts: Date.now() });
  
  // Limit signals to prevent memory bloat
  if (match.signals[partnerId].length > 20) {
    match.signals[partnerId] = match.signals[partnerId].slice(-20);
  }
  
  if (type === 'ready') match.status = 'connected';
  
  // Get my pending signals
  const mySignals = match.signals[userId] || [];
  match.signals[userId] = [];
  
  const ready = mySignals.some(s => s.type === 'ready') || match.status === 'connected';
  
  // Schedule cleanup for successful connections
  if (ready && !match.cleanup) {
    match.cleanup = true;
    setTimeout(() => matches.delete(matchId), 15000);
  }
  
  return res.json({
    status: ready ? 'connected' : 'sent',
    matchId: ready ? undefined : matchId,
    partnerId,
    signals: mySignals,
    connectionReady: ready
  });
}

function handleDisconnect(userId, res) {
  queue = queue.filter(id => id !== userId);
  
  for (const [matchId, match] of matches.entries()) {
    if (match.p1 === userId || match.p2 === userId) {
      matches.delete(matchId);
      break;
    }
  }
  
  return res.json({ status: 'disconnected' });
}

function cleanup() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [matchId, match] of matches.entries()) {
    if (now - match.ts > MATCH_TIMEOUT) {
      matches.delete(matchId);
      cleaned++;
    }
  }
}

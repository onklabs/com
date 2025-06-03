// Optimized signaling server without Redis - using enhanced in-memory storage
// WARNING: Data will be lost on server restart

// Enhanced in-memory storage with automatic cleanup
let waitingQueue = [];
let matches = new Map();
let userMatches = new Map();
let heartbeats = new Map();
let cleanupIntervals = new Map();

const TIMEOUTS = {
  WAITING: 45000,        // 45s in queue
  MATCH: 90000,         // 1.5 minutes match lifetime (changed from 400000)
  HEARTBEAT: 90000,      // 1.5 minutes heartbeat
  SIGNAL: 45000,         // 45s for signals
  CLEANUP_INTERVAL: 90000 // Clean up every 1.5 minutes
};

// Enhanced cleanup system
function startPeriodicCleanup() {
  if (!cleanupIntervals.has('main')) {
    const interval = setInterval(() => {
      const now = Date.now();
      
      // Clean expired heartbeats
      for (const [userId, timestamp] of heartbeats.entries()) {
        if (now - timestamp > TIMEOUTS.HEARTBEAT) {
          heartbeats.delete(userId);
          console.log(`[CLEANUP] Removed expired heartbeat for ${userId}`);
        }
      }
      
      // Clean expired matches
      for (const [matchId, match] of matches.entries()) {
        if (now - match.ts > TIMEOUTS.MATCH) {
          matches.delete(matchId);
          userMatches.delete(match.p1);
          userMatches.delete(match.p2);
          console.log(`[CLEANUP] Removed expired match ${matchId}`);
        }
      }
      
      // Clean waiting queue
      const beforeCount = waitingQueue.length;
      waitingQueue = waitingQueue.filter(p => now - p.ts < TIMEOUTS.WAITING);
      if (waitingQueue.length !== beforeCount) {
        console.log(`[CLEANUP] Cleaned waiting queue: ${beforeCount} -> ${waitingQueue.length}`);
      }
      
    }, TIMEOUTS.CLEANUP_INTERVAL);
    
    cleanupIntervals.set('main', interval);
    console.log('[CLEANUP] Periodic cleanup started');
  }
}

// NEW: Function to clean expired matches on every request
function cleanExpiredMatches() {
  const now = Date.now();
  let cleanedCount = 0;
  const expiredMatches = [];
  
  // Find all expired matches
  for (const [matchId, match] of matches.entries()) {
    const matchAge = now - match.ts;
    if (matchAge > TIMEOUTS.MATCH) {
      expiredMatches.push({ matchId, match, age: matchAge });
    }
  }
  
  // Remove expired matches
  for (const { matchId, match, age } of expiredMatches) {
    matches.delete(matchId);
    userMatches.delete(match.p1);
    userMatches.delete(match.p2);
    cleanedCount++;
    console.log(`[REQUEST_CLEANUP] Removed expired match ${matchId} (age: ${Math.floor(age/1000)}s) - users: ${match.p1}, ${match.p2}`);
  }
  
  if (cleanedCount > 0) {
    console.log(`[REQUEST_CLEANUP] Cleaned ${cleanedCount} expired matches from ${matches.size + cleanedCount} total matches`);
  }
  
  return cleanedCount;
}

// Start cleanup when module loads
startPeriodicCleanup();

export default async function handler(req, res) {
  console.log('=== Enhanced Signaling API Called ===');
  console.log('Method:', req.method);
  console.log('Query keys:', Object.keys(req.query));
  console.log('Body:', req.body);
  
  // NEW: Clean expired matches on every request
  const cleanedMatches = cleanExpiredMatches();
  
  // FIXED: Enhanced CORS headers with all necessary headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 
    'Content-Type, X-Requested-With, Authorization, Accept, Origin, Cache-Control, X-File-Name, X-File-Size, X-File-Type'
  );
  res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  
  if (req.method === 'OPTIONS') {
    console.log('[CORS] Handling preflight request');
    return res.status(200).end();
  }
  
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ 
      status: 'error', 
      message: 'Only GET and POST methods allowed',
      allowed_methods: ['GET', 'POST', 'OPTIONS']
    });
  }
  
  try {
    // Support both GET (query params) and POST (body)
    let requestData = {};
    
    if (req.method === 'GET') {
      requestData = req.query;
    } else if (req.method === 'POST') {
      // Handle both JSON body and query params
      requestData = { ...req.query, ...req.body };
      
      // Convert client 'type' to server 'action'
      if (requestData.type && !requestData.action) {
        requestData.action = requestData.type;
        delete requestData.type;
      }
    }
    
    console.log('[DEBUG] Parsed request data:', JSON.stringify(requestData, null, 2));
    
    const { action, userId, ...params } = requestData;
    const now = Date.now();
    
    // Enhanced validation logging
    if (!action) {
      console.log('[DEBUG] No action provided, returning health check');
    } else if (!userId) {
      console.log('[DEBUG] Missing userId for action:', action);
    } else if (typeof userId !== 'string' || userId.length < 3) {
      console.log('[DEBUG] Invalid userId format:', userId, typeof userId);
    }
    
    // Enhanced health check with detailed stats including cleanup info
    if (!action) {
      const stats = {
        waiting: waitingQueue.length,
        active_matches: matches.size,
        active_users: heartbeats.size,
        matches_cleaned_this_request: cleanedMatches,
        match_timeout_minutes: TIMEOUTS.MATCH / 60000,
        server_uptime: process.uptime ? Math.floor(process.uptime()) : 'unknown',
        memory_usage: process.memoryUsage ? process.memoryUsage() : 'unknown'
      };
      
      return res.status(200).json({
        service: 'Enhanced WebRTC Signaling',
        status: 'online',
        timestamp: now,
        stats: stats,
        version: '2.2.0',
        cors_fixed: true,
        cleanup_enabled: true
      });
    }
    
    // Validate userId
    if (!userId || typeof userId !== 'string' || userId.length < 3) {
      console.log('[ERROR] Invalid userId validation failed:', {
        userId: userId,
        type: typeof userId,
        length: userId ? userId.length : 0
      });
      
      return res.status(400).json({ 
        status: 'error', 
        message: 'Invalid or missing userId parameter',
        expected_format: 'string with minimum 3 characters',
        received: {
          userId: userId,
          type: typeof userId,
          length: userId ? userId.length : 0
        }
      });
    }

    console.log(`[${action?.toUpperCase()}] Processing for user: ${userId}`);
    updateHeartbeat(userId, now);

    let result;
    switch (action) {
      case 'find-match':
        result = await handleFindMatch({ userId, ...params }, now);
        break;
      case 'exchange-signals':
        result = await handleExchangeSignals({ userId, ...params }, now);
        break;
      case 'heartbeat':
        result = await handleHeartbeat({ userId, ...params }, now);
        break;
      case 'disconnect':
        result = await handleDisconnect({ userId, ...params });
        break;
      case 'cleanup-match':
        const matchId = params.matchId;
        const reason = params.reason || 'unknown';
        
        console.log(`[CLEANUP] Match ${matchId} cleanup requested: ${reason}`);
        
        const deleted = deleteMatch(matchId);
        result = {
          status: 'success',
          message: deleted ? 'Match deleted' : 'Match already deleted',
          cleaned: deleted,
          reason: reason
        };
        break;
      default:
        result = { 
          status: 'error', 
          message: `Unknown action: ${action}`,
          available_actions: ['find-match', 'exchange-signals', 'heartbeat', 'disconnect', 'cleanup-match']
        };
    }
    
    console.log(`[${action?.toUpperCase()}] Result: ${result.status}`);
    return res.status(result.status === 'error' ? 400 : 200).json(result);
    
  } catch (error) {
    console.error('[ERROR] Server error:', error.message);
    console.error('[ERROR] Stack:', error.stack);
    console.error('[ERROR] Request method:', req.method);
    console.error('[ERROR] Request query:', req.query);
    console.error('[ERROR] Request body:', req.body);
    
    return res.status(500).json({ 
      status: 'error', 
      message: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      debug_info: {
        method: req.method,
        has_query: !!req.query,
        has_body: !!req.body,
        query_keys: req.query ? Object.keys(req.query) : [],
        body_keys: req.body ? Object.keys(req.body) : []
      },
      timestamp: Date.now()
    });
  }
}

// Enhanced helper functions with better error handling and logging

function updateHeartbeat(userId, timestamp) {
  const previous = heartbeats.get(userId);
  heartbeats.set(userId, timestamp);
  
  if (!previous) {
    console.log(`[HEARTBEAT] New user: ${userId}`);
  }
}

function getMatch(matchId) {
  if (!matchId) return null;
  const match = matches.get(matchId);
  
  // Check if match is expired (this check is now redundant since we clean on every request)
  if (match && Date.now() - match.ts > TIMEOUTS.MATCH) {
    deleteMatch(matchId);
    console.log(`[MATCH] Auto-deleted expired match: ${matchId}`);
    return null;
  }
  
  return match;
}

function setMatch(matchId, matchData) {
  matches.set(matchId, matchData);
  console.log(`[MATCH] Created match: ${matchId} (${matchData.p1} <-> ${matchData.p2}) - expires in ${TIMEOUTS.MATCH/60000} minutes`);
}

function getUserMatch(userId) {
  const matchId = userMatches.get(userId);
  if (!matchId) return null;
  
  // Verify match still exists
  const match = getMatch(matchId);
  if (!match) {
    deleteUserMatch(userId);
    return null;
  }
  
  return matchId;
}

function setUserMatch(userId, matchId) {
  userMatches.set(userId, matchId);
  console.log(`[USER_MATCH] Set ${userId} -> ${matchId}`);
}

function deleteUserMatch(userId) {
  const removed = userMatches.delete(userId);
  if (removed) {
    console.log(`[USER_MATCH] Deleted mapping for ${userId}`);
  }
  return removed;
}

function deleteMatch(matchId) {
  const match = matches.get(matchId);
  if (match) {
    matches.delete(matchId);
    // Also clean up user mappings
    deleteUserMatch(match.p1);
    deleteUserMatch(match.p2);
    console.log(`[MATCH] Deleted match: ${matchId}`);
    return true;
  }
  return false;
}

function getWaitingQueue() {
  // Enhanced cleanup with logging
  const now = Date.now();
  const beforeCount = waitingQueue.length;
  waitingQueue = waitingQueue.filter(p => {
    const isValid = now - p.ts < TIMEOUTS.WAITING;
    if (!isValid) {
      console.log(`[QUEUE] Removed expired user from queue: ${p.id}`);
    }
    return isValid;
  });
  
  if (beforeCount !== waitingQueue.length) {
    console.log(`[QUEUE] Cleaned queue: ${beforeCount} -> ${waitingQueue.length}`);
  }
  
  return waitingQueue;
}

function setWaitingQueue(queue) {
  const previous = waitingQueue.length;
  waitingQueue = queue;
  console.log(`[QUEUE] Updated queue size: ${previous} -> ${queue.length}`);
}

function deterministic_initiator(peer1, peer2) {
  return peer1.localeCompare(peer2) < 0;
}

function createLightweightMatch(peer1, peer2, now) {
  return {
    p1: peer1,
    p2: peer2,
    ts: now,
    st: 'signaling',
    to: {
      o: now + 35000,  // 35s for offer (compromise)
      a: now + 35000,  // 35s for answer (compromise)
      c: now + 120000  // 2 minutes for connection
    },
    s: {
      [peer1]: { o: [], a: [], i: [], k: [] },
      [peer2]: { o: [], a: [], i: [], k: [] }
    }
  };
}

function expandMatch(match) {
  if (!match) return null;
  
  return {
    id: match.id,
    peer1: match.p1,
    peer2: match.p2,
    timestamp: match.ts,
    status: match.st,
    timeouts: {
      offer: match.to.o,
      answer: match.to.a,
      connection: match.to.c
    },
    signaling: {
      [match.p1]: {
        offers: match.s[match.p1]?.o || [],
        answers: match.s[match.p1]?.a || [],
        ice: match.s[match.p1]?.i || [],
        acks: match.s[match.p1]?.k || []
      },
      [match.p2]: {
        offers: match.s[match.p2]?.o || [],
        answers: match.s[match.p2]?.a || [],
        ice: match.s[match.p2]?.i || [],
        acks: match.s[match.p2]?.k || []
      }
    }
  };
}

function compressMatch(match) {
  if (!match) return null;
  
  return {
    p1: match.peer1,
    p2: match.peer2,
    ts: match.timestamp,
    st: match.status,
    to: {
      o: match.timeouts.offer,
      a: match.timeouts.answer,
      c: match.timeouts.connection
    },
    s: {
      [match.peer1]: {
        o: match.signaling[match.peer1]?.offers || [],
        a: match.signaling[match.peer1]?.answers || [],
        i: match.signaling[match.peer1]?.ice || [],
        k: match.signaling[match.peer1]?.acks || []
      },
      [match.peer2]: {
        o: match.signaling[match.peer2]?.offers || [],
        a: match.signaling[match.peer2]?.answers || [],
        i: match.signaling[match.peer2]?.ice || [],
        k: match.signaling[match.peer2]?.acks || []
      }
    }
  };
}

async function validateMatch(matchId, peerId) {
  console.log(`[VALIDATE] Checking match ${matchId} for user ${peerId}`);
  
  if (!matchId || !peerId) {
    console.log(`[VALIDATE] Missing parameters: matchId=${matchId}, peerId=${peerId}`);
    return { valid: false, error: 'Missing matchId or peerId' };
  }
  
  const match = getMatch(matchId);
  if (!match) {
    console.log(`[VALIDATE] Match not found: ${matchId}`);
    console.log(`[VALIDATE] Available matches:`, Array.from(matches.keys()));
    return { valid: false, error: 'Match not found' };
  }
  
  if (match.p1 !== peerId && match.p2 !== peerId) {
    console.log(`[VALIDATE] Unauthorized access to match ${matchId} by ${peerId}`);
    console.log(`[VALIDATE] Match participants: ${match.p1}, ${match.p2}`);
    return { valid: false, error: 'Unauthorized' };
  }
  
  const now = Date.now();
  const matchAge = now - match.ts;
  console.log(`[VALIDATE] Match age: ${matchAge}ms, timeout: ${TIMEOUTS.MATCH}ms`);
  
  if (matchAge > TIMEOUTS.MATCH) {
    console.log(`[VALIDATE] Match expired: ${matchId} (age: ${matchAge}ms)`);
    deleteMatch(matchId);
    return { valid: false, error: 'Match expired' };
  }
  
  console.log(`[VALIDATE] Match valid: ${matchId}`);
  return { valid: true, match: expandMatch(match) };
}

async function cleanExpiredSignals(match, now) {
  if (!match) return null;
  
  const cleaned = { ...match };
  let totalCleaned = 0;
  
  for (const peerId of [match.peer1, match.peer2]) {
    const signals = cleaned.signaling[peerId];
    if (!signals) continue;
    
    const beforeOffers = signals.offers.length;
    const beforeAnswers = signals.answers.length;
    const beforeIce = signals.ice.length;
    const beforeAcks = signals.acks.length;
    
    signals.offers = signals.offers.filter(s => now - s.ts < TIMEOUTS.SIGNAL);
    signals.answers = signals.answers.filter(s => now - s.ts < TIMEOUTS.SIGNAL);
    signals.ice = signals.ice.filter(s => now - s.ts < 20000);
    signals.acks = signals.acks.filter(s => now - s.ts < TIMEOUTS.SIGNAL);
    
    const cleaned_count = (beforeOffers - signals.offers.length) + 
                         (beforeAnswers - signals.answers.length) + 
                         (beforeIce - signals.ice.length) + 
                         (beforeAcks - signals.acks.length);
    
    totalCleaned += cleaned_count;
  }
  
  if (totalCleaned > 0) {
    console.log(`[SIGNALS] Cleaned ${totalCleaned} expired signals from match`);
  }
  
  return cleaned;
}

async function handleFindMatch(data, now) {
  console.log(`[FIND_MATCH] Starting for user ${data.userId}`);
  
  // Check for existing match first
  const existingMatchId = getUserMatch(data.userId);
  if (existingMatchId) {
    const existingMatch = getMatch(existingMatchId);
    if (existingMatch) {
      const expanded = expandMatch(existingMatch);
      const partnerId = expanded.peer1 === data.userId ? expanded.peer2 : expanded.peer1;
      
      // Reset match status to allow reconnection (moderate timeouts)
      existingMatch.st = 'signaling';
      existingMatch.to = {
        o: now + 35000,
        a: now + 35000, 
        c: now + 120000
      };
      
      setMatch(existingMatchId, existingMatch);
      
      console.log(`[FIND_MATCH] Found existing match: ${existingMatchId}, reset for reconnection`);
      
      return {
        status: 'matched',
        matchId: existingMatchId,
        partnerId: partnerId,
        isInitiator: deterministic_initiator(data.userId, partnerId),
        existing: true,
        reconnecting: true,
        timestamp: now
      };
    } else {
      deleteUserMatch(data.userId);
      console.log(`[FIND_MATCH] Cleaned stale user match for ${data.userId}`);
    }
  }
  
  // Get current queue and remove current user if present
  let queue = getWaitingQueue();
  queue = queue.filter(p => p.id !== data.userId);
  
  // Enhanced matching logic with timezone preference
  const timezone = parseFloat(data.timezone) || 0;
  const compatiblePeer = queue.find(p => {
    if (!timezone && !p.tz) return true; // Both have no timezone preference
    if (!timezone || !p.tz) return true; // One has no preference, allow match
    return Math.abs(p.tz - timezone) <= 12; // Within 12 hours
  });
  
  if (compatiblePeer) {
    // Create match with deterministic initiator
    const peer1 = deterministic_initiator(data.userId, compatiblePeer.id) ? data.userId : compatiblePeer.id;
    const peer2 = peer1 === data.userId ? compatiblePeer.id : data.userId;
    
    const matchId = `m_${now}_${Math.random().toString(36).substr(2, 8)}`;
    const matchInfo = createLightweightMatch(peer1, peer2, now);
    
    // DEBUG: Log match creation details
    console.log(`[MATCH_CREATE] Creating match ${matchId} - will expire in ${TIMEOUTS.MATCH/60000} minutes`);
    console.log(`[MATCH_CREATE] Peer1: ${peer1}, Peer2: ${peer2}`);
    console.log(`[MATCH_CREATE] Initiator: ${deterministic_initiator(data.userId, compatiblePeer.id) ? data.userId : compatiblePeer.id}`);
    console.log(`[MATCH_CREATE] Match timeouts:`, matchInfo.to);
    
    // Set up the match
    setMatch(matchId, matchInfo);
    setUserMatch(data.userId, matchId);
    setUserMatch(compatiblePeer.id, matchId);
    
    // DEBUG: Verify match was saved
    const savedMatch = getMatch(matchId);
    console.log(`[MATCH_CREATE] Match saved successfully:`, !!savedMatch);
    
    // Remove both users from queue
    const newQueue = queue.filter(p => p.id !== compatiblePeer.id);
    setWaitingQueue(newQueue);
    
    console.log(`[FIND_MATCH] Created new match: ${data.userId} <-> ${compatiblePeer.id}`);
    
    return { 
      status: 'matched',
      matchId,
      partnerId: compatiblePeer.id,
      isInitiator: deterministic_initiator(data.userId, compatiblePeer.id),
      existing: false,
      timestamp: now
    };
  }
  
  // No match found, add to queue
  queue.push({ 
    id: data.userId, 
    tz: timezone,
    ts: now
  });
  
  setWaitingQueue(queue);
  console.log(`[FIND_MATCH] Added ${data.userId} to queue, position: ${queue.length}`);
  
  return { 
    status: 'waiting',
    position: queue.length,
    estimated_wait: Math.min(queue.length * 5, 60), // Rough estimate in seconds
    timestamp: now
  };
}
// Utility function to safely parse data that might be URL-encoded or direct JSON
function safeParseData(data) {
  if (!data) return null;
  
  // If already an object, return as-is
  if (typeof data === 'object') {
    return data;
  }
  
  // If string, try to parse
  if (typeof data === 'string') {
    try {
      // First try direct JSON parse
      return JSON.parse(data);
    } catch (directParseError) {
      try {
        // Then try with URL decode first
        return JSON.parse(decodeURIComponent(data));
      } catch (urlDecodeError) {
        console.error('Failed to parse data:', data, directParseError.message, urlDecodeError.message);
        return null;
      }
    }
  }
  
  return null;
}

// Updated handleExchangeSignals function with safer parsing
async function handleExchangeSignals(data, now) {
  if (!data.matchId) {
    console.log('[EXCHANGE] Missing matchId');
    return { status: 'error', message: 'Missing matchId parameter' };
  }
  
  console.log('[EXCHANGE] Processing signals for match:', data.matchId, 'user:', data.userId);
  console.log('[EXCHANGE] Data keys:', Object.keys(data));
  
  const validation = await validateMatch(data.matchId, data.userId);
  if (!validation.valid) {
    console.log('[EXCHANGE] Validation failed:', validation.error);
    return { status: 'error', message: validation.error };
  }
  
  let match = validation.match;
  match = await cleanExpiredSignals(match, now);
  
  const partnerId = match.peer1 === data.userId ? match.peer2 : match.peer1;
  let signalsAdded = 0;
  
  // UPDATED: Enhanced signal parsing with safer method
  if (data.offer) {
    try {
      const offer = safeParseData(data.offer);
      
      if (offer && now < match.timeouts.offer) {
        match.signaling[partnerId].offers.push({
          f: data.userId,
          d: offer,
          ts: now,
          id: `o_${now}_${Math.random().toString(36).substr(2, 4)}`
        });
        signalsAdded++;
        console.log(`[SIGNALS] Added offer from ${data.userId} to ${partnerId}`);
      } else if (!offer) {
        console.error('[SIGNALS] Failed to parse offer data');
      } else {
        console.log(`[SIGNALS] Offer timeout expired for ${data.userId}`);
      }
    } catch (e) {
      console.error('[SIGNALS] Failed to process offer:', e.message, 'Data:', data.offer);
    }
  }
  
  if (data.answer) {
    try {
      const answer = safeParseData(data.answer);
      
      if (answer && now < match.timeouts.answer) {
        match.signaling[partnerId].answers.push({
          f: data.userId,
          d: answer,
          ts: now,
          id: `a_${now}_${Math.random().toString(36).substr(2, 4)}`
        });
        signalsAdded++;
        console.log(`[SIGNALS] Added answer from ${data.userId} to ${partnerId}`);
      } else if (!answer) {
        console.error('[SIGNALS] Failed to parse answer data');
      } else {
        console.log(`[SIGNALS] Answer timeout expired for ${data.userId}`);
      }
    } catch (e) {
      console.error('[SIGNALS] Failed to process answer:', e.message, 'Data:', data.answer);
    }
  }
  
  if (data.ice) {
    try {
      const ice = safeParseData(data.ice);
      
      if (Array.isArray(ice) && now < match.timeouts.connection) {
        const currentIce = match.signaling[partnerId].ice.length;
        const availableSlots = Math.max(0, 15 - currentIce);
        const candidatesToAdd = ice.slice(0, availableSlots);
        
        candidatesToAdd.forEach(candidate => {
          match.signaling[partnerId].ice.push({
            f: data.userId,
            d: candidate,
            ts: now,
            id: `i_${now}_${Math.random().toString(36).substr(2, 4)}`
          });
          signalsAdded++;
        });
        
        if (candidatesToAdd.length > 0) {
          console.log(`[SIGNALS] Added ${candidatesToAdd.length} ICE candidates from ${data.userId}`);
        }
      } else if (!ice) {
        console.error('[SIGNALS] Failed to parse ICE data');
      } else {
        console.log(`[SIGNALS] ICE timeout expired or invalid format for ${data.userId}`);
      }
    } catch (e) {
      console.error('[SIGNALS] Failed to process ICE candidates:', e.message, 'Data:', data.ice);
    }
  }
  
  // Handle acknowledgments and special signals (no change needed)
  if (data.connectionReady === 'true' || data.connectionReady === true) {
    match.signaling[partnerId].acks.push({
      t: 'ready',
      f: data.userId,
      ts: now,
      id: `r_${now}_${Math.random().toString(36).substr(2, 4)}`
    });
    match.status = 'connected';
    console.log(`[SIGNALS] Connection ready from ${data.userId}`);
    signalsAdded++;
  }
  
  if (data.ping === 'true' || data.ping === true) {
    match.signaling[partnerId].acks.push({
      t: 'ping',
      f: data.userId,
      ts: now,
      id: `p_${now}_${Math.random().toString(36).substr(2, 4)}`
    });
    console.log(`[SIGNALS] Ping from ${data.userId}`);
    signalsAdded++;
  }
  
  // UPDATED: Process acknowledgments with safer parsing
  if (data.acknowledgeIds) {
    try {
      const ackIds = safeParseData(data.acknowledgeIds);
      
      if (Array.isArray(ackIds) && ackIds.length > 0) {
        const signals = match.signaling[data.userId];
        let ackedCount = 0;
        
        signals.offers = signals.offers.filter(s => {
          if (ackIds.includes(s.id)) {
            ackedCount++;
            return false;
          }
          return true;
        });
        
        signals.answers = signals.answers.filter(s => {
          if (ackIds.includes(s.id)) {
            ackedCount++;
            return false;
          }
          return true;
        });
        
        signals.ice = signals.ice.filter(s => {
          if (ackIds.includes(s.id)) {
            ackedCount++;
            return false;
          }
          return true;
        });
        
        signals.acks = signals.acks.filter(s => {
          if (ackIds.includes(s.id)) {
            ackedCount++;
            return false;
          }
          return true;
        });
        
        if (ackedCount > 0) {
          console.log(`[SIGNALS] Acknowledged ${ackedCount} signals for ${data.userId}`);
        }
      } else if (data.acknowledgeIds) {
        console.error('[SIGNALS] Failed to parse acknowledgeIds or not an array');
      }
    } catch (e) {
      console.error('[SIGNALS] Failed to process acknowledgeIds:', e.message);
    }
  }
  
  // Save updated match
  setMatch(data.matchId, compressMatch(match));
  
  // Prepare response with pending signals (no change needed)
  const mySignals = match.signaling[data.userId];
  const pendingSignals = {
    offers: mySignals.offers.map(s => ({
      from: s.f,
      offer: s.d,
      timestamp: s.ts,
      id: s.id
    })),
    answers: mySignals.answers.map(s => ({
      from: s.f,
      answer: s.d,
      timestamp: s.ts,
      id: s.id
    })),
    ice: mySignals.ice.map(s => ({
      from: s.f,
      candidate: s.d,
      timestamp: s.ts,
      id: s.id
    })),
    acks: mySignals.acks.map(s => ({
      type: s.t,
      from: s.f,
      timestamp: s.ts,
      id: s.id
    }))
  };
  
  const allSignalIds = [
    ...pendingSignals.offers.map(s => s.id),
    ...pendingSignals.answers.map(s => s.id),
    ...pendingSignals.ice.map(s => s.id),
    ...pendingSignals.acks.map(s => s.id)
  ];
  
  const totalPending = allSignalIds.length;
  if (totalPending > 0) {
    console.log(`[SIGNALS] Returning ${totalPending} pending signals to ${data.userId}`);
  }
  
  return {
    status: 'signals',
    signals: pendingSignals,
    signalIds: allSignalIds,
    partnerId: partnerId,
    matchStatus: match.status,
    signalsAdded: signalsAdded,
    timestamp: now
  };
}
 
async function handleHeartbeat(data, now) {
  const existingMatchId = getUserMatch(data.userId);
  if (existingMatchId) {
    const match = getMatch(existingMatchId);
    if (match) {
      const expanded = expandMatch(match);
      const partnerId = expanded.peer1 === data.userId ? expanded.peer2 : expanded.peer1;
      
      return {
        status: 'alive',
        matched: true,
        matchId: existingMatchId,
        partnerId: partnerId,
        isInitiator: deterministic_initiator(data.userId, partnerId),
        matchStatus: expanded.status,
        timestamp: now
      };
    } else {
      deleteUserMatch(data.userId);
      console.log(`[HEARTBEAT] Cleaned stale match reference for ${data.userId}`);
    }
  }
  
  return { 
    status: 'alive',
    matched: false,
    timestamp: now
  };
}

async function handleDisconnect(data) {
  console.log(`[DISCONNECT] Processing disconnect for ${data.userId}`);
  
  // Remove from waiting queue
  const queue = getWaitingQueue();
  const filteredQueue = queue.filter(p => p.id !== data.userId);
  if (filteredQueue.length !== queue.length) {
    setWaitingQueue(filteredQueue);
    console.log(`[DISCONNECT] Removed ${data.userId} from waiting queue`);
  }
  
  // Handle active match
  const existingMatchId = getUserMatch(data.userId);
  if (existingMatchId) {
    const match = getMatch(existingMatchId);
    if (match) {
      const partnerId = match.p1 === data.userId ? match.p2 : match.p1;
      deleteUserMatch(partnerId);
      console.log(`[DISCONNECT] Cleaned partner mapping: ${partnerId}`);
    }
    deleteMatch(existingMatchId);
    deleteUserMatch(data.userId);
    console.log(`[DISCONNECT] Cleaned match and user mapping for ${data.userId}`);
  }
  
  // Remove heartbeat
  heartbeats.delete(data.userId);
  
  return { 
    status: 'disconnected',
    timestamp: Date.now()
  };
}
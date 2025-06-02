// Vercel Compatible Signaling Server - No WebSocket
// Uses session-based matching with client-side state management

const CONFIG = {
  SESSION_TIMEOUT: 180000, // 3 minutes
  MATCH_COOLDOWN: 5000, // 5 seconds between matches
  QUEUE_LIMIT: 100
};

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
        timestamp: Date.now(),
        server: 'stateless-http',
        stats: { message: 'Vercel serverless signaling' }
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
      
      switch (action) {
        case 'join-queue':
          return handleJoin(userId, res);
        case 'send-signal':
          return handleSendSignal(userId, data, res);
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
    const now = Date.now();
    
    // Generate session-based match
    const matchData = generateSessionMatch(userId, now);
    
    if (matchData.hasMatch) {
      console.log(`[POLL] ${userId} -> matched with ${matchData.partnerId}`);
      
      return res.json({
        status: 'matched',
        matchId: matchData.matchId,
        partnerId: matchData.partnerId,
        isInitiator: matchData.isInitiator,
        signals: [], // Client manages signals
        connectionReady: false,
        timestamp: now
      });
    }
    
    // Calculate deterministic queue position
    const position = getQueuePosition(userId, now);
    
    if (position <= CONFIG.QUEUE_LIMIT) {
      console.log(`[POLL] ${userId} -> waiting, position: ${position}`);
      
      return res.json({
        status: 'waiting',
        position,
        estimatedWait: Math.min(position * 2, 45),
        timestamp: now
      });
    }
    
    console.log(`[POLL] ${userId} -> not found`);
    
    return res.json({ 
      status: 'not_found', 
      action_needed: 'join-queue',
      timestamp: now
    });
    
  } catch (error) {
    console.error('[POLL ERROR]', error);
    return res.status(500).json({ error: 'Poll failed' });
  }
}

function handleJoin(userId, res) {
  try {
    const now = Date.now();
    
    // Check for session match
    const matchData = generateSessionMatch(userId, now);
    
    if (matchData.hasMatch) {
      console.log(`[JOIN] ${userId} -> matched with ${matchData.partnerId}`);
      
      return res.json({
        status: 'matched',
        matchId: matchData.matchId,
        partnerId: matchData.partnerId,
        isInitiator: matchData.isInitiator,
        signals: [],
        connectionReady: false,
        timestamp: now
      });
    }
    
    // Return queue position
    const position = getQueuePosition(userId, now);
    
    console.log(`[JOIN] ${userId} -> queued at position ${position}`);
    
    return res.json({
      status: 'queued',
      position,
      estimatedWait: Math.min(position * 2, 45),
      timestamp: now
    });
    
  } catch (error) {
    console.error('[JOIN ERROR]', error);
    return res.status(500).json({ error: 'Join failed' });
  }
}

function handleSendSignal(userId, data, res) {
  try {
    const { matchId, type, payload } = data;
    const now = Date.now();
    
    // Validate match exists (extract from matchId)
    const matchValid = validateSessionMatch(matchId, userId, now);
    
    if (!matchValid.valid) {
      return res.status(404).json({ error: 'Match not found or expired' });
    }
    
    console.log(`[SEND] ${userId} -> ${matchValid.partnerId} (${type})`);
    
    // Signal sent successfully (client handles the rest)
    const ready = type === 'ready';
    
    return res.json({
      status: ready ? 'connected' : 'sent',
      matchId: ready ? undefined : matchId,
      partnerId: matchValid.partnerId,
      signals: [], // Client aggregates signals
      connectionReady: ready,
      timestamp: now
    });
    
  } catch (error) {
    console.error('[SEND ERROR]', error);
    return res.status(500).json({ error: 'Send failed' });
  }
}

function handleDisconnect(userId, res) {
  try {
    console.log(`[DISCONNECT] ${userId}`);
    
    return res.json({ 
      status: 'disconnected',
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('[DISCONNECT ERROR]', error);
    return res.status(500).json({ error: 'Disconnect failed' });
  }
}

// ==========================================
// SESSION-BASED MATCHING (DETERMINISTIC)
// ==========================================

function generateSessionMatch(userId, timestamp) {
  // Create time windows for matching
  const matchWindow = Math.floor(timestamp / CONFIG.MATCH_COOLDOWN);
  const userHash = hashString(userId);
  
  // Try to find a match in current or recent windows
  for (let windowOffset = 0; windowOffset <= 2; windowOffset++) {
    const currentWindow = matchWindow - windowOffset;
    
    // Generate potential partner for this window
    const seed = (userHash + currentWindow) % 1000000;
    const partnerId = generatePartnerUserId(seed);
    
    // Avoid self-matching
    if (partnerId === userId) continue;
    
    // Check if this creates a bidirectional match
    const partnerHash = hashString(partnerId);
    const partnerSeed = (partnerHash + currentWindow) % 1000000;
    const partnerFoundUserId = generatePartnerUserId(partnerSeed);
    
    if (partnerFoundUserId === userId) {
      // Bidirectional match found!
      const p1 = userId < partnerId ? userId : partnerId;
      const p2 = userId < partnerId ? partnerId : userId;
      const matchId = `session_${currentWindow}_${Math.min(userHash, partnerHash)}`;
      
      return {
        hasMatch: true,
        partnerId,
        matchId,
        isInitiator: userId === p1,
        windowId: currentWindow
      };
    }
  }
  
  return { hasMatch: false };
}

function validateSessionMatch(matchId, userId, timestamp) {
  try {
    // Parse matchId: session_window_hash
    const parts = matchId.split('_');
    if (parts.length !== 3 || parts[0] !== 'session') {
      return { valid: false };
    }
    
    const windowId = parseInt(parts[1]);
    const matchHash = parseInt(parts[2]);
    
    // Check if window is still valid
    const currentWindow = Math.floor(timestamp / CONFIG.MATCH_COOLDOWN);
    if (currentWindow - windowId > 10) { // Max 10 windows (50 seconds)
      return { valid: false };
    }
    
    // Regenerate match to find partner
    const userHash = hashString(userId);
    const seed = (userHash + windowId) % 1000000;
    const partnerId = generatePartnerUserId(seed);
    
    // Verify match hash
    const partnerHash = hashString(partnerId);
    const expectedHash = Math.min(userHash, partnerHash);
    
    if (expectedHash !== matchHash) {
      return { valid: false };
    }
    
    return {
      valid: true,
      partnerId,
      windowId
    };
    
  } catch (error) {
    return { valid: false };
  }
}

function getQueuePosition(userId, timestamp) {
  // Deterministic position based on user hash and time
  const timeSlot = Math.floor(timestamp / (CONFIG.MATCH_COOLDOWN * 2));
  const userHash = hashString(userId);
  
  // Position rotates every time slot
  return ((userHash + timeSlot) % CONFIG.QUEUE_LIMIT) + 1;
}

function generatePartnerUserId(seed) {
  // Generate consistent partner ID from seed
  return `user_${seed.toString().padStart(6, '0')}`;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash) % 1000000;
}
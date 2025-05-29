// api/signaling.js - Fixed signaling server with match validation

// In-memory storage
let waitingQueue = [];
let matches = new Map(); // Store temporary match info
let heartbeats = new Map();

// Cleanup every 30 seconds
setInterval(() => {
  const now = Date.now();
  
  // Clean expired heartbeats (2 minutes)
  for (const [peerId, lastSeen] of heartbeats.entries()) {
    if (now - lastSeen > 120000) {
      heartbeats.delete(peerId);
      waitingQueue = waitingQueue.filter(p => p.peerId !== peerId);
    }
  }
  
  // Clean old waiting queue entries (1 minute)
  waitingQueue = waitingQueue.filter(p => now - p.timestamp < 60000);
  
  // Clean old matches (10 minutes - increased from 5 minutes)
  for (const [matchId, match] of matches.entries()) {
    if (now - match.timestamp > 600000) {
      matches.delete(matchId);
    }
  }
  
  // Clean old signals within matches (only signals older than 30 seconds)
  for (const [matchId, match] of matches.entries()) {
    for (const peerId in match.signaling) {
      const signals = match.signaling[peerId];
      
      // Clean old offers/answers/ice
      signals.offers = signals.offers.filter(s => now - s.timestamp < 30000);
      signals.answers = signals.answers.filter(s => now - s.timestamp < 30000);
      signals.ice = signals.ice.filter(s => now - s.timestamp < 30000);
    }
  }
}, 30000);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method === 'GET') {
    return handleGetRequest(req, res);
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      status: 'error', 
      message: 'Method not allowed' 
    });
  }
  
  try {
    const data = req.body;
    const now = Date.now();
    
    if (!data || !data.type) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid request data'
      });
    }

    let result;
    switch (data.type) {
      case 'find-match':
        result = handleFindMatch(data, now);
        break;
      
      case 'exchange-offer':
        result = handleExchangeOffer(data, now);
        break;
      
      case 'exchange-answer':
        result = handleExchangeAnswer(data, now);
        break;
        
      case 'exchange-ice':
        result = handleExchangeIce(data, now);
        break;
      
      case 'heartbeat':
        result = handleHeartbeat(data, now);
        break;
      
      case 'cancel-search':
        result = handleCancelSearch(data);
        break;
        
      case 'acknowledge-signals':
        result = handleAcknowledgeSignals(data, now);
        break;
      
      default:
        result = { status: 'error', message: 'Unknown request type' };
    }
    
    return res.status(result.status === 'error' ? 400 : 200).json(result);
    
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Server error'
    });
  }
}

function handleGetRequest(req, res) {
  const now = Date.now();
  
  const stats = {
    service: 'WebRTC Matching Server',
    status: 'online',
    timestamp: now,
    stats: {
      waiting: waitingQueue.length,
      active_matches: matches.size,
      server_time: new Date().toISOString()
    }
  };
  
  return res.status(200).json(stats);
}

function validateMatch(matchId, peerId, operation) {
  const match = matches.get(matchId);
  
  if (!match) {
    console.log(`[VALIDATION] Match ${matchId} not found for ${operation}`);
    return { valid: false, error: 'Match not found' };
  }
  
  // Check if peer is part of this match
  if (match.peer1 !== peerId && match.peer2 !== peerId) {
    console.log(`[VALIDATION] Peer ${peerId} not authorized for match ${matchId}`);
    return { valid: false, error: 'Unauthorized' };
  }
  
  // Check if match is not too old (10 minutes)
  const now = Date.now();
  if (now - match.timestamp > 600000) {
    console.log(`[VALIDATION] Match ${matchId} expired`);
    matches.delete(matchId); // Clean expired match
    return { valid: false, error: 'Match expired' };
  }
  
  return { valid: true, match: match };
}

function handleFindMatch(data, now) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }
  
  try {
    // Update heartbeat
    heartbeats.set(data.peerId, now);
    
    // Remove from waiting queue if already exists
    waitingQueue = waitingQueue.filter(p => p.peerId !== data.peerId);
    
    // Look for available peer
    const availablePeer = waitingQueue.find(p => 
      p.peerId !== data.peerId && 
      now - p.timestamp < 30000 // Only recent entries
    );
    
    if (availablePeer) {
      // Create match
      const matchId = `match_${Math.random().toString(36).substr(2, 12)}`;
      
      // Create match record
      const matchInfo = {
        id: matchId,
        peer1: data.peerId,
        peer2: availablePeer.peerId,
        timestamp: now,
        status: 'matched',
        signaling: {
          [data.peerId]: { offers: [], answers: [], ice: [] },
          [availablePeer.peerId]: { offers: [], answers: [], ice: [] }
        }
      };
      
      matches.set(matchId, matchInfo);
      
      // Remove matched peer from queue
      waitingQueue = waitingQueue.filter(p => p.peerId !== availablePeer.peerId);
      
      console.log('Match created:', matchId, data.peerId, '<->', availablePeer.peerId);
      
      return { 
        status: 'matched', 
        matchId: matchId,
        partnerId: availablePeer.peerId,
        isInitiator: true,
        timestamp: now
      };
    }
    
    // Add to waiting queue
    waitingQueue.push({ 
      peerId: data.peerId, 
      timestamp: now
    });
    
    return { 
      status: 'waiting',
      position: waitingQueue.length,
      timestamp: now
    };
    
  } catch (error) {
    console.error('Find match error:', error);
    return { status: 'error', message: 'Find match failed' };
  }
}

function handleExchangeOffer(data, now) {
  if (!data.matchId || !data.peerId || !data.offer) {
    return { status: 'error', message: 'Missing required fields' };
  }
  
  try {
    // Validate match
    const validation = validateMatch(data.matchId, data.peerId, 'exchange-offer');
    if (!validation.valid) {
      return { status: 'error', message: validation.error };
    }
    
    const match = validation.match;
    
    // Store offer for the other peer to retrieve
    const partnerId = match.peer1 === data.peerId ? match.peer2 : match.peer1;
    match.signaling[partnerId].offers.push({
      from: data.peerId,
      offer: data.offer,
      timestamp: now
    });
    
    matches.set(data.matchId, match);
    
    console.log(`[EXCHANGE] Offer stored for match ${data.matchId}: ${data.peerId} -> ${partnerId}`);
    
    return { 
      status: 'offer_stored',
      partnerId: partnerId,
      timestamp: now
    };
    
  } catch (error) {
    console.error('Exchange offer error:', error);
    return { status: 'error', message: 'Exchange offer failed' };
  }
}

function handleExchangeAnswer(data, now) {
  if (!data.matchId || !data.peerId || !data.answer) {
    return { status: 'error', message: 'Missing required fields' };
  }
  
  try {
    // Validate match
    const validation = validateMatch(data.matchId, data.peerId, 'exchange-answer');
    if (!validation.valid) {
      return { status: 'error', message: validation.error };
    }
    
    const match = validation.match;
    
    // Store answer for the other peer to retrieve
    const partnerId = match.peer1 === data.peerId ? match.peer2 : match.peer1;
    match.signaling[partnerId].answers.push({
      from: data.peerId,
      answer: data.answer,
      timestamp: now
    });
    
    matches.set(data.matchId, match);
    
    console.log(`[EXCHANGE] Answer stored for match ${data.matchId}: ${data.peerId} -> ${partnerId}`);
    
    return { 
      status: 'answer_stored',
      partnerId: partnerId,
      timestamp: now
    };
    
  } catch (error) {
    console.error('Exchange answer error:', error);
    return { status: 'error', message: 'Exchange answer failed' };
  }
}

function handleExchangeIce(data, now) {
  if (!data.matchId || !data.peerId || !data.candidate) {
    return { status: 'error', message: 'Missing required fields' };
  }
  
  try {
    // Validate match
    const validation = validateMatch(data.matchId, data.peerId, 'exchange-ice');
    if (!validation.valid) {
      return { status: 'error', message: validation.error };
    }
    
    const match = validation.match;
    
    // Store ICE candidate for the other peer to retrieve
    const partnerId = match.peer1 === data.peerId ? match.peer2 : match.peer1;
    match.signaling[partnerId].ice.push({
      from: data.peerId,
      candidate: data.candidate,
      timestamp: now
    });
    
    matches.set(data.matchId, match);
    
    return { 
      status: 'ice_stored',
      partnerId: partnerId,
      timestamp: now
    };
    
  } catch (error) {
    console.error('Exchange ICE error:', error);
    return { status: 'error', message: 'Exchange ICE failed' };
  }
}

function handleHeartbeat(data, now) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }
  
  try {
    heartbeats.set(data.peerId, now);
    
    // Check if user has a match and get pending signals
    let matchInfo = null;
    let pendingSignals = null;
    
    for (const [matchId, match] of matches.entries()) {
      if (match.peer1 === data.peerId || match.peer2 === data.peerId) {
        // Validate match before proceeding
        const validation = validateMatch(matchId, data.peerId, 'heartbeat');
        if (!validation.valid) {
          continue; // Skip invalid matches
        }
        
        matchInfo = {
          matchId: matchId,
          partnerId: match.peer1 === data.peerId ? match.peer2 : match.peer1,
          isInitiator: match.peer1 === data.peerId
        };
        
        // Get pending signals WITHOUT clearing them immediately
        const signals = match.signaling[data.peerId];
        pendingSignals = {
          offers: [...signals.offers],
          answers: [...signals.answers],
          ice: [...signals.ice]
        };
        
        console.log(`[HEARTBEAT] Signals for ${data.peerId}: offers=${signals.offers.length}, answers=${signals.answers.length}, ice=${signals.ice.length}`);
        
        break;
      }
    }
    
    return { 
      status: 'alive',
      matched: !!matchInfo,
      match: matchInfo,
      signals: pendingSignals,
      timestamp: now
    };
    
  } catch (error) {
    console.error('Heartbeat error:', error);
    return { status: 'error', message: 'Heartbeat failed' };
  }
}

function handleAcknowledgeSignals(data, now) {
  if (!data.peerId || !data.matchId) {
    return { status: 'error', message: 'Missing required fields' };
  }
  
  try {
    // Validate match
    const validation = validateMatch(data.matchId, data.peerId, 'acknowledge-signals');
    if (!validation.valid) {
      return { status: 'error', message: validation.error };
    }
    
    const match = validation.match;
    
    // Clear acknowledged signals
    const signals = match.signaling[data.peerId];
    
    if (data.acknowledgedOffers) {
      signals.offers = signals.offers.filter(offer => 
        !data.acknowledgedOffers.includes(offer.timestamp)
      );
    }
    
    if (data.acknowledgedAnswers) {
      signals.answers = signals.answers.filter(answer => 
        !data.acknowledgedAnswers.includes(answer.timestamp)
      );
    }
    
    if (data.acknowledgedIce) {
      signals.ice = signals.ice.filter(ice => 
        !data.acknowledgedIce.includes(ice.timestamp)
      );
    }
    
    matches.set(data.matchId, match);
    
    console.log(`[ACK] Signals acknowledged for ${data.peerId} in match ${data.matchId}`);
    
    return { 
      status: 'acknowledged',
      timestamp: now
    };
    
  } catch (error) {
    console.error('Acknowledge signals error:', error);
    return { status: 'error', message: 'Acknowledge signals failed' };
  }
}

function handleCancelSearch(data) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }
  
  try {
    // Remove from waiting queue
    waitingQueue = waitingQueue.filter(p => p.peerId !== data.peerId);
    
    // Remove heartbeat
    heartbeats.delete(data.peerId);
    
    return { 
      status: 'cancelled',
      timestamp: Date.now()
    };
    
  } catch (error) {
    console.error('Cancel search error:', error);
    return { status: 'error', message: 'Cancel search failed' };
  }
}
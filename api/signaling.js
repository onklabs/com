import { kv } from '@vercel/kv';

const WAITING_QUEUE_KEY = 'waiting_queue';
const MATCH_PREFIX = 'match:';
const USER_MATCH_PREFIX = 'user_match:';
const HEARTBEAT_PREFIX = 'heartbeat:';

const TIMEOUTS = {
  WAITING: 30000,
  MATCH: 300000,
  HEARTBEAT: 60000,
  SIGNAL: 30000 
};

// Helper function to parse request body
async function parseBody(req) {
  if (req.body) {
    // Body already parsed by Vercel
    return req.body;
  }
  
  // Manual parsing if needed
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  console.log('=== Signaling API Called ===');
  console.log('Method:', req.method);
  console.log('Content-Type:', req.headers['content-type']);
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  if (req.method === 'OPTIONS') {
    console.log('OPTIONS request handled');
    return res.status(200).end();
  }
  
  if (req.method === 'GET') {
    console.log('GET request - health check');
    try {
      const [waiting, matches] = await Promise.all([
        kv.get(WAITING_QUEUE_KEY),
        kv.keys(`${MATCH_PREFIX}*`)
      ]);
      
      return res.status(200).json({
        service: 'WebRTC Signaling',
        status: 'online',
        timestamp: Date.now(),
        stats: {
          waiting: (waiting || []).length,
          active_matches: matches?.length || 0
        }
      });
    } catch (error) {
      console.error('GET error:', error);
      return res.status(200).json({
        service: 'WebRTC Signaling',
        status: 'online',
        timestamp: Date.now(),
        kv_status: 'error',
        error: error.message
      });
    }
  }
  
  if (req.method !== 'POST') {
    console.log('Method not allowed:', req.method);
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  
  try {
    console.log('Parsing POST body...');
    console.log('Raw body:', req.body);
    
    // Parse request body
    let data;
    try {
      data = await parseBody(req);
      console.log('Parsed data:', data);
    } catch (parseError) {
      console.error('Body parsing error:', parseError);
      return res.status(400).json({ 
        status: 'error', 
        message: 'Invalid JSON in request body',
        details: parseError.message 
      });
    }
    
    const now = Date.now();
    
    if (!data?.type || !data?.userId) {
      console.log('Invalid request data:', data);
      return res.status(400).json({ 
        status: 'error', 
        message: 'Invalid request - missing type or userId',
        received: data
      });
    }

    console.log('Processing request:', data.type, 'for user:', data.userId);
    
    // Test KV connection before processing
    try {
      await updateHeartbeat(data.userId, now);
      console.log('Heartbeat updated successfully');
    } catch (kvError) {
      console.error('KV error during heartbeat update:', kvError);
      return res.status(500).json({ 
        status: 'error', 
        message: 'Database connection error',
        details: kvError.message 
      });
    }

    let result;
    switch (data.type) {
      case 'find-match':
        console.log('Handling find-match');
        result = await handleFindMatch(data, now);
        break;
      case 'exchange-signals':
        console.log('Handling exchange-signals');
        result = await handleExchangeSignals(data, now);
        break;
      case 'heartbeat':
        console.log('Handling heartbeat');
        result = await handleHeartbeat(data, now);
        break;
      case 'disconnect':
        console.log('Handling disconnect');
        result = await handleDisconnect(data);
        break;
      default:
        console.log('Unknown request type:', data.type);
        result = { status: 'error', message: 'Unknown type: ' + data.type };
    }
    
    console.log('Request processed successfully, result:', result);
    return res.status(result.status === 'error' ? 400 : 200).json(result);
    
  } catch (error) {
    console.error('=== SERVER ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    return res.status(500).json({ 
      status: 'error', 
      message: 'Server error',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
}

async function updateHeartbeat(userId, timestamp) {
  console.log('Updating heartbeat for:', userId);
  await kv.setex(`${HEARTBEAT_PREFIX}${userId}`, Math.ceil(TIMEOUTS.HEARTBEAT / 1000), timestamp);
}

async function getMatch(matchId) {
  if (!matchId) return null;
  return await kv.get(`${MATCH_PREFIX}${matchId}`);
}

async function setMatch(matchId, matchData, ttl = Math.ceil(TIMEOUTS.MATCH / 1000)) {
  await kv.setex(`${MATCH_PREFIX}${matchId}`, ttl, matchData);
}

async function getUserMatch(userId) {
  return await kv.get(`${USER_MATCH_PREFIX}${userId}`);
}

async function setUserMatch(userId, matchId, ttl = Math.ceil(TIMEOUTS.MATCH / 1000)) {
  await kv.setex(`${USER_MATCH_PREFIX}${userId}`, ttl, matchId);
}

async function deleteUserMatch(userId) {
  await kv.del(`${USER_MATCH_PREFIX}${userId}`);
}

async function deleteMatch(matchId) {
  await kv.del(`${MATCH_PREFIX}${matchId}`);
}

async function getWaitingQueue() {
  const queue = await kv.get(WAITING_QUEUE_KEY);
  return queue || [];
}

async function setWaitingQueue(queue, ttl = Math.ceil(TIMEOUTS.WAITING / 1000)) {
  if (queue.length === 0) {
    await kv.del(WAITING_QUEUE_KEY);
  } else {
    await kv.setex(WAITING_QUEUE_KEY, ttl, queue);
  }
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
      o: now + 15000,
      a: now + 15000,
      c: now + 60000
    },
    s: {
      [peer1]: { o: [], a: [], i: [], k: [] },
      [peer2]: { o: [], a: [], i: [], k: [] }
    }
  };
}

function expandMatch(match) {
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
        offers: match.s[match.p1].o || [],
        answers: match.s[match.p1].a || [],
        ice: match.s[match.p1].i || [],
        acks: match.s[match.p1].k || []
      },
      [match.p2]: {
        offers: match.s[match.p2].o || [],
        answers: match.s[match.p2].a || [],
        ice: match.s[match.p2].i || [],
        acks: match.s[match.p2].k || []
      }
    }
  };
}

function compressMatch(match) {
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
        o: match.signaling[match.peer1].offers || [],
        a: match.signaling[match.peer1].answers || [],
        i: match.signaling[match.peer1].ice || [],
        k: match.signaling[match.peer1].acks || []
      },
      [match.peer2]: {
        o: match.signaling[match.peer2].offers || [],
        a: match.signaling[match.peer2].answers || [],
        i: match.signaling[match.peer2].ice || [],
        k: match.signaling[match.peer2].acks || []
      }
    }
  };
}

async function validateMatch(matchId, peerId) {
  const match = await getMatch(matchId);
  if (!match) return { valid: false, error: 'Match not found' };
  
  if (match.p1 !== peerId && match.p2 !== peerId) {
    return { valid: false, error: 'Unauthorized' };
  }
  
  const now = Date.now();
  if (now - match.ts > TIMEOUTS.MATCH) {
    await Promise.all([
      deleteMatch(matchId),
      deleteUserMatch(match.p1),
      deleteUserMatch(match.p2)
    ]);
    return { valid: false, error: 'Match expired' };
  }
  
  return { valid: true, match: expandMatch(match) };
}

async function cleanExpiredSignals(match, now) {
  const cleaned = { ...match };
  
  for (const peerId of [match.peer1, match.peer2]) {
    const signals = cleaned.signaling[peerId];
    signals.offers = signals.offers.filter(s => now - s.ts < TIMEOUTS.SIGNAL);
    signals.answers = signals.answers.filter(s => now - s.ts < TIMEOUTS.SIGNAL);
    signals.ice = signals.ice.filter(s => now - s.ts < 20000);
    signals.acks = signals.acks.filter(s => now - s.ts < TIMEOUTS.SIGNAL);
  }
  
  return cleaned;
}

async function handleFindMatch(data, now) {
  const existingMatchId = await getUserMatch(data.userId);
  if (existingMatchId) {
    const existingMatch = await getMatch(existingMatchId);
    if (existingMatch) {
      const expanded = expandMatch(existingMatch);
      const partnerId = expanded.peer1 === data.userId ? expanded.peer2 : expanded.peer1;
      return {
        status: 'matched',
        matchId: existingMatchId,
        partnerId: partnerId,
        isInitiator: deterministic_initiator(data.userId, partnerId),
        existing: true,
        timestamp: now
      };
    } else {
      await deleteUserMatch(data.userId);
    }
  }
  
  let queue = await getWaitingQueue();
  queue = queue.filter(p => now - p.ts < TIMEOUTS.WAITING && p.id !== data.userId);
  
  const compatiblePeer = queue.find(p => 
    !data.timezone || !p.tz || Math.abs(p.tz - data.timezone) <= 12
  );
  
  if (compatiblePeer) {
    const peer1 = deterministic_initiator(data.userId, compatiblePeer.id) ? data.userId : compatiblePeer.id;
    const peer2 = peer1 === data.userId ? compatiblePeer.id : data.userId;
    
    const matchId = `m_${now}_${Math.random().toString(36).substr(2, 8)}`;
    const matchInfo = createLightweightMatch(peer1, peer2, now);
    
    await Promise.all([
      setMatch(matchId, matchInfo),
      setUserMatch(data.userId, matchId),
      setUserMatch(compatiblePeer.id, matchId),
      setWaitingQueue(queue.filter(p => p.id !== compatiblePeer.id))
    ]);
    
    return { 
      status: 'matched',
      matchId,
      partnerId: compatiblePeer.id,
      isInitiator: deterministic_initiator(data.userId, compatiblePeer.id),
      existing: false,
      timestamp: now
    };
  }
  
  queue.push({ 
    id: data.userId, 
    tz: data.timezone || 0,
    ts: now
  });
  
  await setWaitingQueue(queue);
  
  return { 
    status: 'waiting',
    position: queue.length,
    timestamp: now
  };
}

async function handleExchangeSignals(data, now) {
  if (!data.matchId) {
    return { status: 'error', message: 'Missing matchId' };
  }
  
  const validation = await validateMatch(data.matchId, data.userId);
  if (!validation.valid) {
    return { status: 'error', message: validation.error };
  }
  
  let match = validation.match;
  match = await cleanExpiredSignals(match, now);
  
  const partnerId = match.peer1 === data.userId ? match.peer2 : match.peer1;
  
  if (data.offer && now < match.timeouts.offer) {
    match.signaling[partnerId].offers.push({
      f: data.userId,
      d: data.offer,
      ts: now,
      id: `o_${now}_${Math.random().toString(36).substr(2, 4)}`
    });
  }
  
  if (data.answer && now < match.timeouts.answer) {
    match.signaling[partnerId].answers.push({
      f: data.userId,
      d: data.answer,
      ts: now,
      id: `a_${now}_${Math.random().toString(36).substr(2, 4)}`
    });
  }
  
  if (data.ice && data.ice.length > 0 && now < match.timeouts.connection) {
    const currentIce = match.signaling[partnerId].ice.length;
    data.ice.slice(0, Math.max(0, 10 - currentIce)).forEach(candidate => {
      match.signaling[partnerId].ice.push({
        f: data.userId,
        d: candidate,
        ts: now,
        id: `i_${now}_${Math.random().toString(36).substr(2, 4)}`
      });
    });
  }
  
  if (data.connectionReady) {
    match.signaling[partnerId].acks.push({
      t: 'ready',
      f: data.userId,
      ts: now,
      id: `r_${now}_${Math.random().toString(36).substr(2, 4)}`
    });
    match.status = 'connected';
  }
  
  if (data.ping) {
    match.signaling[partnerId].acks.push({
      t: 'ping',
      f: data.userId,
      ts: now,
      id: `p_${now}_${Math.random().toString(36).substr(2, 4)}`
    });
  }
  
  if (data.acknowledgeIds && data.acknowledgeIds.length > 0) {
    const signals = match.signaling[data.userId];
    const ackIds = data.acknowledgeIds;
    
    signals.offers = signals.offers.filter(s => !ackIds.includes(s.id));
    signals.answers = signals.answers.filter(s => !ackIds.includes(s.id));
    signals.ice = signals.ice.filter(s => !ackIds.includes(s.id));
    signals.acks = signals.acks.filter(s => !ackIds.includes(s.id));
  }
  
  await setMatch(data.matchId, compressMatch(match));
  
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
  
  return {
    status: 'signals',
    signals: pendingSignals,
    signalIds: allSignalIds,
    partnerId: partnerId,
    matchStatus: match.status,
    timestamp: now
  };
}

async function handleHeartbeat(data, now) {
  const existingMatchId = await getUserMatch(data.userId);
  if (existingMatchId) {
    const match = await getMatch(existingMatchId);
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
      await deleteUserMatch(data.userId);
    }
  }
  
  return { 
    status: 'alive',
    matched: false,
    timestamp: now
  };
}

async function handleDisconnect(data) {
  const queue = await getWaitingQueue();
  const filteredQueue = queue.filter(p => p.id !== data.userId);
  await setWaitingQueue(filteredQueue);
  
  const existingMatchId = await getUserMatch(data.userId);
  if (existingMatchId) {
    const match = await getMatch(existingMatchId);
    if (match) {
      const partnerId = match.p1 === data.userId ? match.p2 : match.p1;
      await deleteUserMatch(partnerId);
    }
    await Promise.all([
      deleteMatch(existingMatchId),
      deleteUserMatch(data.userId)
    ]);
  }
  
  await kv.del(`${HEARTBEAT_PREFIX}${data.userId}`);
  
  return { 
    status: 'disconnected',
    timestamp: Date.now()
  };
}
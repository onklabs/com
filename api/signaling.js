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

export default async function handler(req, res) {
  console.log('=== Signaling API Called ===');
  console.log('Method:', req.method);
  console.log('Query:', req.query);
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'Only GET method allowed' });
  }
  
  try {
    const { action, userId, ...params } = req.query;
    const now = Date.now();
    
    // Health check
    if (!action) {
      const [waiting, matches] = await Promise.all([
        kv.get(WAITING_QUEUE_KEY),
        kv.keys(`${MATCH_PREFIX}*`)
      ]);
      
      return res.status(200).json({
        service: 'WebRTC Signaling',
        status: 'online',
        timestamp: now,
        stats: {
          waiting: (waiting || []).length,
          active_matches: matches?.length || 0
        }
      });
    }
    
    if (!userId) {
      return res.status(400).json({ status: 'error', message: 'Missing userId parameter' });
    }

    console.log('Processing action:', action, 'for user:', userId);
    await updateHeartbeat(userId, now);

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
      default:
        result = { status: 'error', message: 'Unknown action: ' + action };
    }
    
    return res.status(result.status === 'error' ? 400 : 200).json(result);
    
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ 
      status: 'error', 
      message: 'Server error',
      details: error.message
    });
  }
}

async function updateHeartbeat(userId, timestamp) {
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
  
  const timezone = parseFloat(data.timezone) || 0;
  const compatiblePeer = queue.find(p => 
    !timezone || !p.tz || Math.abs(p.tz - timezone) <= 12
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
    tz: timezone,
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
  
  // Parse complex data from query params
  if (data.offer) {
    try {
      const offer = JSON.parse(decodeURIComponent(data.offer));
      if (now < match.timeouts.offer) {
        match.signaling[partnerId].offers.push({
          f: data.userId,
          d: offer,
          ts: now,
          id: `o_${now}_${Math.random().toString(36).substr(2, 4)}`
        });
      }
    } catch (e) {
      console.error('Failed to parse offer:', e);
    }
  }
  
  if (data.answer) {
    try {
      const answer = JSON.parse(decodeURIComponent(data.answer));
      if (now < match.timeouts.answer) {
        match.signaling[partnerId].answers.push({
          f: data.userId,
          d: answer,
          ts: now,
          id: `a_${now}_${Math.random().toString(36).substr(2, 4)}`
        });
      }
    } catch (e) {
      console.error('Failed to parse answer:', e);
    }
  }
  
  if (data.ice) {
    try {
      const ice = JSON.parse(decodeURIComponent(data.ice));
      if (Array.isArray(ice) && now < match.timeouts.connection) {
        const currentIce = match.signaling[partnerId].ice.length;
        ice.slice(0, Math.max(0, 10 - currentIce)).forEach(candidate => {
          match.signaling[partnerId].ice.push({
            f: data.userId,
            d: candidate,
            ts: now,
            id: `i_${now}_${Math.random().toString(36).substr(2, 4)}`
          });
        });
      }
    } catch (e) {
      console.error('Failed to parse ice:', e);
    }
  }
  
  if (data.connectionReady === 'true') {
    match.signaling[partnerId].acks.push({
      t: 'ready',
      f: data.userId,
      ts: now,
      id: `r_${now}_${Math.random().toString(36).substr(2, 4)}`
    });
    match.status = 'connected';
  }
  
  if (data.ping === 'true') {
    match.signaling[partnerId].acks.push({
      t: 'ping',
      f: data.userId,
      ts: now,
      id: `p_${now}_${Math.random().toString(36).substr(2, 4)}`
    });
  }
  
  if (data.acknowledgeIds) {
    try {
      const ackIds = JSON.parse(decodeURIComponent(data.acknowledgeIds));
      const signals = match.signaling[data.userId];
      
      signals.offers = signals.offers.filter(s => !ackIds.includes(s.id));
      signals.answers = signals.answers.filter(s => !ackIds.includes(s.id));
      signals.ice = signals.ice.filter(s => !ackIds.includes(s.id));
      signals.acks = signals.acks.filter(s => !ackIds.includes(s.id));
    } catch (e) {
      console.error('Failed to parse acknowledgeIds:', e);
    }
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
let waitingQueue = [];
let matches = new Map();
let heartbeats = new Map();
let pendingMatched = new Map(); // NEW: lưu client chưa được phản hồi matched

setInterval(() => {
  const now = Date.now();

  for (const [peerId, lastSeen] of heartbeats.entries()) {
    if (now - lastSeen > 120000) {
      heartbeats.delete(peerId);
      waitingQueue = waitingQueue.filter(p => p.peerId !== peerId);
      pendingMatched.delete(peerId); // xóa khỏi pendingMatched nếu timeout
    }
  }

  waitingQueue = waitingQueue.filter(p => now - p.timestamp < 60000);

  for (const [matchId, match] of matches.entries()) {
    if (now - match.timestamp > 300000) {
      matches.delete(matchId);
    }
  }
}, 30000);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let data = {};

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      data = Object.fromEntries(url.searchParams.entries());
    } else if (req.method === 'POST') {
      data = req.body;
    }
  } catch (e) {
    return res.status(400).json({ status: 'error', message: 'Failed to parse request' });
  }

  if (!data || typeof data !== 'object') {
    return res.status(400).json({ status: 'error', message: 'Invalid request data' });
  }

  const normalized = normalizeRequest(data);

  if (!normalized.type) {
    return handleGetRequest(req, res);
  }

  const now = Date.now();
  let result;

  try {
    switch (normalized.type) {
      case 'find-match': result = handleFindMatch(normalized, now); break;
      case 'exchange-offer': result = handleExchangeOffer(normalized, now); break;
      case 'exchange-answer': result = handleExchangeAnswer(normalized, now); break;
      case 'exchange-ice': result = handleExchangeIce(normalized, now); break;
      case 'heartbeat': result = handleHeartbeat(normalized, now); break;
      case 'cancel-search': result = handleCancelSearch(normalized); break;
	  case 'send-key': result = handleSendKey(normalized, now); break;
      default: result = { status: 'error', message: 'Unknown request type' };
    }
  } catch (e) {
    console.error('Server Error:', e);
    return res.status(500).json({ status: 'error', message: 'Server crashed', error: String(e) });
  }

  return res.status(result.status === 'error' ? 400 : 200).json(result);
}


function normalizeRequest(data) {
  const map = {
    'offer': 'exchange-offer',
    'answer': 'exchange-answer',
    'ice-candidate': 'exchange-ice',
    'register': 'find-match',   // important
    'roomId': 'matchId'
  };
  const normalized = { ...data };
  if (map[data.type]) normalized.type = map[data.type];
  if (data.roomId && !data.matchId) normalized.matchId = data.roomId;
  return normalized;
}

function handleGetRequest(req, res) {
  const now = Date.now();
  return res.status(200).json({
    service: 'WebRTC Matching Server',
    status: 'online',
    timestamp: now,
    stats: {
      waiting: waitingQueue.length,
      active_matches: matches.size,
      server_time: new Date().toISOString()
    }
  });
}

function handleFindMatch(data, now) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }

  // Trường hợp peer này đã được matched bởi client khác
  if (pendingMatched.has(data.peerId)) {
    const info = pendingMatched.get(data.peerId);
    pendingMatched.delete(data.peerId);
    return {
      status: 'matched',
      matchId: info.matchId,
      partnerId: info.partnerId,
      isInitiator: false,
      timestamp: now
    };
  }

  try {
    heartbeats.set(data.peerId, now);
    waitingQueue = waitingQueue.filter(p => p.peerId !== data.peerId);

    const availablePeer = waitingQueue.find(p =>
      p.peerId !== data.peerId && now - p.timestamp < 30000
    );

    if (availablePeer) {
      const matchId = `match_${Math.random().toString(36).substr(2, 12)}`;

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
      waitingQueue = waitingQueue.filter(p => p.peerId !== availablePeer.peerId);

      // NEW: lưu lại trạng thái matched cho client chưa được phản hồi
      pendingMatched.set(availablePeer.peerId, {
        matchId,
        partnerId: data.peerId,
        timestamp: now
      });

      console.log('Match created:', matchId, data.peerId, '<->', availablePeer.peerId);

      return {
        status: 'matched',
        matchId,
        partnerId: availablePeer.peerId,
        isInitiator: true,
        timestamp: now
      };
    }

    waitingQueue.push({ peerId: data.peerId, timestamp: now });

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
    const match = matches.get(data.matchId);
    if (!match || !match.signaling[data.peerId]) {
      return { status: 'error', message: 'Match not found' };
    }

    const partnerId = match.peer1 === data.peerId ? match.peer2 : match.peer1;
    match.signaling[partnerId].offers.push({ from: data.peerId, offer: data.offer, timestamp: now });
    matches.set(data.matchId, match);

    return { status: 'offer_stored', partnerId, timestamp: now };

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
    const match = matches.get(data.matchId);
    if (!match || !match.signaling[data.peerId]) {
      return { status: 'error', message: 'Match not found' };
    }

    const partnerId = match.peer1 === data.peerId ? match.peer2 : match.peer1;
    match.signaling[partnerId].answers.push({ from: data.peerId, answer: data.answer, timestamp: now });
    matches.set(data.matchId, match);

    return { status: 'answer_stored', partnerId, timestamp: now };

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
    const match = matches.get(data.matchId);
    if (!match || !match.signaling[data.peerId]) {
      return { status: 'error', message: 'Match not found' };
    }

    const partnerId = match.peer1 === data.peerId ? match.peer2 : match.peer1;
    match.signaling[partnerId].ice.push({ from: data.peerId, candidate: data.candidate, timestamp: now });
    matches.set(data.matchId, match);

    return { status: 'ice_stored', partnerId, timestamp: now };

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

    let matchInfo = null;
    let pendingSignals = null;

    for (const [matchId, match] of matches.entries()) {
      if (match.peer1 === data.peerId || match.peer2 === data.peerId) {
        matchInfo = {
          matchId: matchId,
          partnerId: match.peer1 === data.peerId ? match.peer2 : match.peer1,
          isInitiator: match.peer1 === data.peerId
        };

        const signals = match.signaling[data.peerId];
        pendingSignals = {
          offers: [...signals.offers],
          answers: [...signals.answers],
          ice: [...signals.ice]
        };

        signals.offers = [];
        signals.answers = [];
        signals.ice = [];

        matches.set(matchId, match);
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

function handleCancelSearch(data) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }

  try {
    waitingQueue = waitingQueue.filter(p => p.peerId !== data.peerId);
    heartbeats.delete(data.peerId);
    pendingMatched.delete(data.peerId); // NEW: xóa khỏi pending nếu hủy tìm kiếm

    return {
      status: 'cancelled',
      timestamp: Date.now()
    };

  } catch (error) {
    console.error('Cancel search error:', error);
    return { status: 'error', message: 'Cancel search failed' };
  }
}

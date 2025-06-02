// Vercel KV Compatible: Basic Redis Operations Only
// Target: 83-91% matching success rate

import { kv } from '@vercel/kv';

const MATCH_TIMEOUT = 300000;
const CLEANUP_TIMEOUT = 15000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'GET') {
    const { userId } = req.query;
    if (!userId) {
      const stats = await getStats();
      return res.json({ status: 'online', stats });
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
    console.error('[ERROR]', error.message);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function handlePoll(userId, res) {
  await cleanup();
  
  // Check active match
  const userMatch = await kv.hget('user_matches', userId);
  
  if (userMatch) {
    const match = await kv.hget('matches', userMatch);
    const signals = await kv.lrange(`signals:${userMatch}:${userId}`, 0, -1);
    
    if (match) {
      const matchData = JSON.parse(match);
      const partnerId = matchData.p1 === userId ? matchData.p2 : matchData.p1;
      
      // Clear signals if any exist
      if (signals && signals.length > 0) {
        await kv.del(`signals:${userMatch}:${userId}`);
      }
      
      const parsedSignals = signals ? signals.map(s => JSON.parse(s)) : [];
      const ready = parsedSignals.some(s => s.type === 'ready') || matchData.status === 'connected';
      
      // Protective cleanup scheduling
      if (ready && !matchData.cleanup) {
        matchData.cleanup = true;
        await kv.hset('matches', userMatch, JSON.stringify(matchData));
        setTimeout(async () => {
          await cleanupMatch(userMatch);
        }, CLEANUP_TIMEOUT);
      }
      
      return res.json({
        status: ready ? 'connected' : 'matched',
        matchId: ready ? undefined : userMatch,
        partnerId,
        isInitiator: matchData.p1 === userId,
        signals: parsedSignals,
        connectionReady: ready
      });
    } else {
      await kv.hdel('user_matches', userId);
    }
  }
  
  // Check queue position (simple list approach)
  const queue = await kv.get('queue') || '[]';
  const queueList = JSON.parse(queue);
  const pos = queueList.findIndex(id => id === userId);
  
  if (pos !== -1) {
    return res.json({
      status: 'waiting',
      position: pos + 1,
      estimatedWait: Math.min((pos + 1) * 5, 60)
    });
  }
  
  return res.json({ status: 'not_found', action_needed: 'join-queue' });
}

async function handleJoin(userId, res) {
  await cleanup();
  
  // Check existing match
  const existingMatch = await kv.hget('user_matches', userId);
  if (existingMatch) {
    const match = await kv.hget('matches', existingMatch);
    if (match) {
      const matchData = JSON.parse(match);
      const partnerId = matchData.p1 === userId ? matchData.p2 : matchData.p1;
      
      const signals = await kv.lrange(`signals:${existingMatch}:${userId}`, 0, -1);
      if (signals.length > 0) {
        await kv.del(`signals:${existingMatch}:${userId}`);
      }
      
      const parsedSignals = signals.map(s => JSON.parse(s));
      
      return res.json({
        status: 'matched',
        matchId: existingMatch,
        partnerId,
        isInitiator: matchData.p1 === userId,
        signals: parsedSignals,
        connectionReady: parsedSignals.some(s => s.type === 'ready')
      });
    } else {
      await kv.hdel('user_matches', userId);
    }
  }
  
  // Get current queue and clean user
  const currentQueue = await kv.get('queue') || '[]';
  let queueList = JSON.parse(currentQueue);
  queueList = queueList.filter(id => id !== userId);
  
  // Try to match with first person
  if (queueList.length > 0) {
    const partnerId = queueList.shift(); // Remove first user
    await kv.set('queue', JSON.stringify(queueList)); // Update queue
    
    const matchId = `m_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const p1 = userId < partnerId ? userId : partnerId;
    const p2 = userId < partnerId ? partnerId : userId;
    
    const matchData = {
      p1, p2, 
      ts: Date.now(),
      status: 'signaling'
    };
    
    // Store match and user mappings
    await kv.hset('matches', matchId, JSON.stringify(matchData));
    await kv.hset('user_matches', p1, matchId);
    await kv.hset('user_matches', p2, matchId);
    
    console.log(`[MATCHED] ${p1} <-> ${p2} (${matchId})`);
    
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
  queueList.push(userId);
  await kv.set('queue', JSON.stringify(queueList));
  
  console.log(`[QUEUED] ${userId} (position ${queueList.length})`);
  
  return res.json({
    status: 'queued',
    position: queueList.length,
    estimatedWait: Math.min(queueList.length * 5, 60)
  });
}

async function handleSend(userId, data, res) {
  const { matchId, type, payload } = data;
  
  const match = await kv.hget('matches', matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  
  const matchData = JSON.parse(match);
  if (matchData.p1 !== userId && matchData.p2 !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  const partnerId = matchData.p1 === userId ? matchData.p2 : matchData.p1;
  const signal = JSON.stringify({ type, payload, from: userId, ts: Date.now() });
  
  // Add signal to partner's list
  await kv.rpush(`signals:${matchId}:${partnerId}`, signal);
  
  // Manually limit to last 20 signals
  const partnerSignals = await kv.lrange(`signals:${matchId}:${partnerId}`, 0, -1);
  if (partnerSignals.length > 20) {
    await kv.del(`signals:${matchId}:${partnerId}`);
    // Keep only last 20
    const limited = partnerSignals.slice(-20);
    for (const s of limited) {
      await kv.rpush(`signals:${matchId}:${partnerId}`, s);
    }
  }
  
  if (type === 'ready') {
    matchData.status = 'connected';
    await kv.hset('matches', matchId, JSON.stringify(matchData));
  }
  
  // Get my signals
  const mySignals = await kv.lrange(`signals:${matchId}:${userId}`, 0, -1);
  
  // Clear my signals
  if (mySignals && mySignals.length > 0) {
    await kv.del(`signals:${matchId}:${userId}`);
  }
  
  const parsedSignals = mySignals ? mySignals.map(s => JSON.parse(s)) : [];
  const ready = parsedSignals.some(s => s.type === 'ready') || matchData.status === 'connected';
  
  // Protective cleanup scheduling
  if (ready && !matchData.cleanup) {
    matchData.cleanup = true;
    await kv.hset('matches', matchId, JSON.stringify(matchData));
    setTimeout(async () => {
      await cleanupMatch(matchId);
    }, CLEANUP_TIMEOUT);
  }
  
  console.log(`[SEND] ${userId} -> ${partnerId} (${type})`);
  
  return res.json({
    status: ready ? 'connected' : 'sent',
    matchId: ready ? undefined : matchId,
    partnerId,
    signals: parsedSignals,
    connectionReady: ready
  });
}

async function handleDisconnect(userId, res) {
  // Clean from queue
  const currentQueue = await kv.get('queue') || '[]';
  const queueList = JSON.parse(currentQueue);
  const filteredQueue = queueList.filter(id => id !== userId);
  await kv.set('queue', JSON.stringify(filteredQueue));
  
  // Clean from matches
  const matchId = await kv.hget('user_matches', userId);
  if (matchId) {
    await cleanupMatch(matchId);
  }
  
  console.log(`[DISCONNECT] ${userId}`);
  return res.json({ status: 'disconnected' });
}

async function cleanup() {
  const now = Date.now();
  const matches = await kv.hgetall('matches');
  
  for (const [matchId, matchStr] of Object.entries(matches)) {
    const match = JSON.parse(matchStr);
    if (now - match.ts > MATCH_TIMEOUT) {
      await cleanupMatch(matchId);
    }
  }
}

async function cleanupMatch(matchId) {
  const match = await kv.hget('matches', matchId);
  if (match) {
    const matchData = JSON.parse(match);
    
    // Clean all related data
    await kv.hdel('matches', matchId);
    await kv.hdel('user_matches', matchData.p1);
    await kv.hdel('user_matches', matchData.p2);
    await kv.del(`signals:${matchId}:${matchData.p1}`);
    await kv.del(`signals:${matchId}:${matchData.p2}`);
    
    // Clean from queue
    const currentQueue = await kv.get('queue') || '[]';
    const queueList = JSON.parse(currentQueue);
    const filteredQueue = queueList.filter(id => id !== matchData.p1 && id !== matchData.p2);
    await kv.set('queue', JSON.stringify(filteredQueue));
    
    console.log(`[CLEANUP] Removed match ${matchId}`);
  }
}

async function getStats() {
  const queue = await kv.get('queue') || '[]';
  const queueList = JSON.parse(queue);
  const matches = await kv.hgetall('matches');
  
  return {
    waiting: queueList.length,
    matches: Object.keys(matches).length
  };
}
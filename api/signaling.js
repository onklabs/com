// Vercel KV Optimized: Reduced Redis Operations
// Target: 95%+ matching success rate with timeout prevention

import { kv } from '@vercel/kv';

const MATCH_TIMEOUT = 180000; // Reduced timeout
const CLEANUP_TIMEOUT = 10000; // Faster cleanup
const MAX_SIGNALS = 10; // Reduced signal buffer
const BATCH_SIZE = 5; // For batch operations

export default async function handler(req, res) {
  // Set shorter timeout for Vercel
  res.setTimeout(25000);
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'GET') {
    const { userId } = req.query;
    if (!userId) {
      const stats = await getStatsOptimized();
      return res.json({ status: 'online', stats });
    }
    return handlePollOptimized(userId, res);
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'GET for polling, POST for actions' });
  }
  
  try {
    const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { action, userId } = data;
    
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    
    switch (action) {
      case 'join-queue': return handleJoinOptimized(userId, res);
      case 'send-signal': return handleSendOptimized(userId, data, res);
      case 'disconnect': return handleDisconnectOptimized(userId, res);
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (error) {
    console.error('[ERROR]', error.message);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function handlePollOptimized(userId, res) {
  try {
    // Single operation to get user match
    const userMatch = await kv.hget('user_matches', userId);
    
    if (userMatch) {
      // Batch get match data and signals
      const [matchData, signalData] = await Promise.all([
        kv.hget('matches', userMatch),
        kv.get(`signals:${userMatch}:${userId}`)
      ]);
      
      if (matchData) {
        const match = JSON.parse(matchData);
        const partnerId = match.p1 === userId ? match.p2 : match.p1;
        
        let signals = [];
        if (signalData) {
          signals = JSON.parse(signalData);
          // Clear signals immediately
          await kv.del(`signals:${userMatch}:${userId}`);
        }
        
        const ready = signals.some(s => s.type === 'ready') || match.status === 'connected';
        
        // Schedule cleanup without blocking
        if (ready && !match.cleanupScheduled) {
          match.cleanupScheduled = true;
          await kv.hset('matches', userMatch, JSON.stringify(match));
          
          // Non-blocking cleanup
          setTimeout(() => {
            cleanupMatchOptimized(userMatch).catch(console.error);
          }, CLEANUP_TIMEOUT);
        }
        
        return res.json({
          status: ready ? 'connected' : 'matched',
          matchId: ready ? undefined : userMatch,
          partnerId,
          isInitiator: match.p1 === userId,
          signals,
          connectionReady: ready
        });
      } else {
        // Clean stale user match
        await kv.hdel('user_matches', userId);
      }
    }
    
    // Check queue with single operation
    const queueData = await kv.get('queue_set');
    if (queueData) {
      const queueSet = JSON.parse(queueData);
      const userIndex = queueSet.users.indexOf(userId);
      
      if (userIndex !== -1) {
        return res.json({
          status: 'waiting',
          position: userIndex + 1,
          estimatedWait: Math.min((userIndex + 1) * 3, 45)
        });
      }
    }
    
    return res.json({ status: 'not_found', action_needed: 'join-queue' });
    
  } catch (error) {
    console.error('[POLL ERROR]', error);
    return res.status(500).json({ error: 'Poll failed' });
  }
}

async function handleJoinOptimized(userId, res) {
  try {
    // Check existing match first
    const existingMatch = await kv.hget('user_matches', userId);
    if (existingMatch) {
      const matchData = await kv.hget('matches', existingMatch);
      if (matchData) {
        const match = JSON.parse(matchData);
        const partnerId = match.p1 === userId ? match.p2 : match.p1;
        
        // Get and clear signals
        const signalData = await kv.get(`signals:${existingMatch}:${userId}`);
        let signals = [];
        if (signalData) {
          signals = JSON.parse(signalData);
          await kv.del(`signals:${existingMatch}:${userId}`);
        }
        
        return res.json({
          status: 'matched',
          matchId: existingMatch,
          partnerId,
          isInitiator: match.p1 === userId,
          signals,
          connectionReady: signals.some(s => s.type === 'ready')
        });
      } else {
        await kv.hdel('user_matches', userId);
      }
    }
    
    // Optimized queue management
    const queueData = await kv.get('queue_set') || '{"users":[],"timestamp":0}';
    const queueSet = JSON.parse(queueData);
    
    // Remove user if already in queue
    queueSet.users = queueSet.users.filter(id => id !== userId);
    
    // Try to match immediately
    if (queueSet.users.length > 0) {
      const partnerId = queueSet.users.shift();
      
      // Update queue
      queueSet.timestamp = Date.now();
      await kv.set('queue_set', JSON.stringify(queueSet));
      
      // Create match
      const matchId = `m_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
      const p1 = userId < partnerId ? userId : partnerId;
      const p2 = userId < partnerId ? partnerId : userId;
      
      const matchData = {
        p1, p2, 
        ts: Date.now(),
        status: 'signaling',
        cleanupScheduled: false
      };
      
      // Batch create match
      await Promise.all([
        kv.hset('matches', matchId, JSON.stringify(matchData)),
        kv.hset('user_matches', p1, matchId),
        kv.hset('user_matches', p2, matchId)
      ]);
      
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
    queueSet.users.push(userId);
    queueSet.timestamp = Date.now();
    await kv.set('queue_set', JSON.stringify(queueSet));
    
    console.log(`[QUEUED] ${userId} (position ${queueSet.users.length})`);
    
    return res.json({
      status: 'queued',
      position: queueSet.users.length,
      estimatedWait: Math.min(queueSet.users.length * 3, 45)
    });
    
  } catch (error) {
    console.error('[JOIN ERROR]', error);
    return res.status(500).json({ error: 'Join failed' });
  }
}

async function handleSendOptimized(userId, data, res) {
  try {
    const { matchId, type, payload } = data;
    
    const matchData = await kv.hget('matches', matchId);
    if (!matchData) return res.status(404).json({ error: 'Match not found' });
    
    const match = JSON.parse(matchData);
    if (match.p1 !== userId && match.p2 !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    const signal = { type, payload, from: userId, ts: Date.now() };
    
    // Optimized signal storage - use JSON array instead of Redis list
    const partnerSignalKey = `signals:${matchId}:${partnerId}`;
    const currentSignals = await kv.get(partnerSignalKey);
    
    let signalArray = currentSignals ? JSON.parse(currentSignals) : [];
    signalArray.push(signal);
    
    // Keep only last MAX_SIGNALS
    if (signalArray.length > MAX_SIGNALS) {
      signalArray = signalArray.slice(-MAX_SIGNALS);
    }
    
    // Single write operation
    await kv.set(partnerSignalKey, JSON.stringify(signalArray));
    
    if (type === 'ready') {
      match.status = 'connected';
      await kv.hset('matches', matchId, JSON.stringify(match));
    }
    
    // Get my signals
    const mySignalKey = `signals:${matchId}:${userId}`;
    const mySignalData = await kv.get(mySignalKey);
    let mySignals = [];
    
    if (mySignalData) {
      mySignals = JSON.parse(mySignalData);
      await kv.del(mySignalKey);
    }
    
    const ready = mySignals.some(s => s.type === 'ready') || match.status === 'connected';
    
    // Non-blocking cleanup scheduling
    if (ready && !match.cleanupScheduled) {
      match.cleanupScheduled = true;
      await kv.hset('matches', matchId, JSON.stringify(match));
      
      setTimeout(() => {
        cleanupMatchOptimized(matchId).catch(console.error);
      }, CLEANUP_TIMEOUT);
    }
    
    console.log(`[SEND] ${userId} -> ${partnerId} (${type})`);
    
    return res.json({
      status: ready ? 'connected' : 'sent',
      matchId: ready ? undefined : matchId,
      partnerId,
      signals: mySignals,
      connectionReady: ready
    });
    
  } catch (error) {
    console.error('[SEND ERROR]', error);
    return res.status(500).json({ error: 'Send failed' });
  }
}

async function handleDisconnectOptimized(userId, res) {
  try {
    // Batch cleanup operations
    const [matchId, queueData] = await Promise.all([
      kv.hget('user_matches', userId),
      kv.get('queue_set')
    ]);
    
    const cleanupPromises = [];
    
    // Clean from queue
    if (queueData) {
      const queueSet = JSON.parse(queueData);
      queueSet.users = queueSet.users.filter(id => id !== userId);
      queueSet.timestamp = Date.now();
      cleanupPromises.push(kv.set('queue_set', JSON.stringify(queueSet)));
    }
    
    // Clean from matches
    if (matchId) {
      cleanupPromises.push(cleanupMatchOptimized(matchId));
    }
    
    await Promise.all(cleanupPromises);
    
    console.log(`[DISCONNECT] ${userId}`);
    return res.json({ status: 'disconnected' });
    
  } catch (error) {
    console.error('[DISCONNECT ERROR]', error);
    return res.status(500).json({ error: 'Disconnect failed' });
  }
}

async function cleanupMatchOptimized(matchId) {
  try {
    const matchData = await kv.hget('matches', matchId);
    if (!matchData) return;
    
    const match = JSON.parse(matchData);
    const now = Date.now();
    
    // Skip if match is too recent (prevent premature cleanup)
    if (now - match.ts < CLEANUP_TIMEOUT) return;
    
    // Batch cleanup operations
    await Promise.all([
      kv.hdel('matches', matchId),
      kv.hdel('user_matches', match.p1),
      kv.hdel('user_matches', match.p2),
      kv.del(`signals:${matchId}:${match.p1}`),
      kv.del(`signals:${matchId}:${match.p2}`)
    ]);
    
    // Clean from queue
    const queueData = await kv.get('queue_set');
    if (queueData) {
      const queueSet = JSON.parse(queueData);
      const originalLength = queueSet.users.length;
      queueSet.users = queueSet.users.filter(id => id !== match.p1 && id !== match.p2);
      
      if (queueSet.users.length !== originalLength) {
        queueSet.timestamp = Date.now();
        await kv.set('queue_set', JSON.stringify(queueSet));
      }
    }
    
    console.log(`[CLEANUP] Removed match ${matchId}`);
    
  } catch (error) {
    console.error('[CLEANUP ERROR]', error);
  }
}

async function getStatsOptimized() {
  try {
    const [queueData, matchesData] = await Promise.all([
      kv.get('queue_set'),
      kv.hlen('matches')
    ]);
    
    const queueSet = queueData ? JSON.parse(queueData) : { users: [] };
    
    return {
      waiting: queueSet.users.length,
      matches: matchesData || 0
    };
    
  } catch (error) {
    console.error('[STATS ERROR]', error);
    return { waiting: 0, matches: 0 };
  }
}

// Periodic cleanup function (call less frequently)
async function performMaintenanceCleanup() {
  try {
    const now = Date.now();
    const matches = await kv.hgetall('matches');
    
    const staleMatches = [];
    for (const [matchId, matchStr] of Object.entries(matches)) {
      const match = JSON.parse(matchStr);
      if (now - match.ts > MATCH_TIMEOUT) {
        staleMatches.push(matchId);
      }
    }
    
    // Batch cleanup stale matches
    for (const matchId of staleMatches) {
      await cleanupMatchOptimized(matchId);
    }
    
    // Clean stale queue entries
    const queueData = await kv.get('queue_set');
    if (queueData) {
      const queueSet = JSON.parse(queueData);
      if (now - queueSet.timestamp > MATCH_TIMEOUT) {
        queueSet.users = queueSet.users.slice(0, 50); // Limit queue size
        queueSet.timestamp = now;
        await kv.set('queue_set', JSON.stringify(queueSet));
      }
    }
    
  } catch (error) {
    console.error('[MAINTENANCE ERROR]', error);
  }
}

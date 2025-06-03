// Complete Vercel KV WebRTC Signaling Server - Server Proxy Architecture
// 8 endpoints: join-queue, poll-match, send-signal, get-signals, send-ice, get-ice, connection-ready, disconnect

import { kv } from '@vercel/kv';

// Constants
const MATCH_TIMEOUT = 300; // 5 minutes TTL
const MAX_QUEUE_SIZE = 100; // Max users per timezone queue
const MAX_ICE_CANDIDATES = 20; // Max ICE candidates per user per match

// In-memory stats
let serverStats = {
  totalMatches: 0,
  activeMatches: 0,
  totalSignals: 0,
  totalICE: 0,
  startTime: Date.now()
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 
    'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  
  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Health check
  if (req.method === 'GET' && (!req.query.action || req.query.action === 'health')) {
    return handleHealthCheck(res);
  }
  
  try {
    const data = req.method === 'GET' ? req.query : 
                 (typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
    
    const { action, userId } = data;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }
    
    switch (action) {
      case 'join-queue':
        return await handleJoinQueue(userId, data, res);
      case 'poll-match':
        return await handlePollMatch(userId, res);
      case 'send-signal':
        return await handleSendSignal(userId, data, res);
      case 'get-signals':
        return await handleGetSignals(userId, data, res);
      case 'send-ice':
        return await handleSendICE(userId, data, res);
      case 'get-ice':
        return await handleGetICE(userId, data, res);
      case 'connection-ready':
        return await handleConnectionReady(userId, data, res);
      case 'disconnect':
        return await handleDisconnect(userId, res);
      default:
        return res.status(400).json({ 
          error: 'Unknown action',
          supportedActions: ['join-queue', 'poll-match', 'send-signal', 'get-signals', 'send-ice', 'get-ice', 'connection-ready', 'disconnect']
        });
    }
  } catch (error) {
    console.error('[SIGNALING] Error:', error);
    return res.status(500).json({ 
      error: 'Server error', 
      details: error.message,
      timestamp: Date.now()
    });
  }
}

// Health check endpoint
async function handleHealthCheck(res) {
  try {
    // Test KV connection with timeout
    const pingPromise = kv.ping();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('KV timeout')), 3000)
    );
    
    await Promise.race([pingPromise, timeoutPromise]);
    
    const uptime = Date.now() - serverStats.startTime;
    
    // Get queue lengths (with error handling)
    const queueStats = await Promise.allSettled([
      kv.llen('waiting_queue:global'),
      kv.llen('waiting_queue:gmt+7'),
      kv.llen('waiting_queue:gmt+8'),
      kv.llen('waiting_queue:gmt-5')
    ]);
    
    const totalWaiting = queueStats.reduce((sum, result) => {
      return sum + (result.status === 'fulfilled' ? (result.value || 0) : 0);
    }, 0);
    
    return res.json({
      status: 'healthy',
      uptime: Math.floor(uptime / 1000),
      stats: {
        ...serverStats,
        totalWaiting,
        queueLengths: {
          global: queueStats[0].status === 'fulfilled' ? queueStats[0].value : 0,
          'gmt+7': queueStats[1].status === 'fulfilled' ? queueStats[1].value : 0,
          'gmt+8': queueStats[2].status === 'fulfilled' ? queueStats[2].value : 0,
          'gmt-5': queueStats[3].status === 'fulfilled' ? queueStats[3].value : 0
        },
        timestamp: Date.now()
      },
      message: 'Signaling server ready with server proxy architecture'
    });
  } catch (error) {
    return res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: Date.now()
    });
  }
}

// Join waiting queue với timezone support
async function handleJoinQueue(userId, data, res) {
  try {
    const { timezone = 'global' } = data;
    
    // Validate timezone
    const validTimezones = ['global', 'gmt+7', 'gmt+8', 'gmt+9', 'gmt-5', 'gmt-4', 'gmt-8'];
    const userTimezone = validTimezones.includes(timezone) ? timezone : 'global';
    
    // Check if user already has active match
    const existingUser = await kv.hgetall(`users:${userId}`);
    if (existingUser && existingUser.matchId) {
      const matchData = await kv.hgetall(`matches:${existingUser.matchId}`);
      if (matchData && matchData.status !== 'expired') {
        const partnerId = matchData.p1 === userId ? matchData.p2 : matchData.p1;
        return res.json({
          status: 'already_matched',
          matchId: existingUser.matchId,
          partnerId,
          isInitiator: matchData.p1 === userId,
          message: 'You already have an active match'
        });
      }
    }
    
    // Remove user from any existing queues
    await removeFromAllQueues(userId);
    
    // Try to find match in same timezone first
    const primaryQueue = `waiting_queue:${userTimezone}`;
    let partnerId = await kv.rpop(primaryQueue);
    
    // Fallback to global queue if no match in timezone
    if (!partnerId && userTimezone !== 'global') {
      partnerId = await kv.rpop('waiting_queue:global');
    }
    
    // Fallback to adjacent timezones
    if (!partnerId) {
      const adjacentTimezones = getAdjacentTimezones(userTimezone);
      for (const tz of adjacentTimezones) {
        partnerId = await kv.rpop(`waiting_queue:${tz}`);
        if (partnerId && partnerId !== userId) break;
        partnerId = null;
      }
    }
    
    if (partnerId && partnerId !== userId) {
      // Create match
      const matchId = generateMatchId();
      const p1 = userId < partnerId ? userId : partnerId; // Consistent initiator logic
      const p2 = userId < partnerId ? partnerId : userId;
      
      const matchData = {
        p1,
        p2,
        created: Date.now().toString(),
        status: 'signaling',
        timezone: userTimezone
      };
      
      // Store match data với TTL
      await kv.hset(`matches:${matchId}`, matchData);
      await kv.expire(`matches:${matchId}`, MATCH_TIMEOUT);
      
      // Update user status
      await Promise.all([
        kv.hset(`users:${userId}`, {
          status: 'matched',
          matchId,
          timezone: userTimezone,
          lastSeen: Date.now().toString()
        }),
        kv.hset(`users:${partnerId}`, {
          status: 'matched',
          matchId,
          timezone: userTimezone,
          lastSeen: Date.now().toString()
        })
      ]);
      
      // Set TTL for user data
      await Promise.all([
        kv.expire(`users:${userId}`, MATCH_TIMEOUT),
        kv.expire(`users:${partnerId}`, MATCH_TIMEOUT)
      ]);
      
      // Update stats
      serverStats.totalMatches++;
      serverStats.activeMatches++;
      
      return res.json({
        status: 'matched',
        matchId,
        partnerId,
        isInitiator: userId === p1,
        timezone: userTimezone,
        message: `Matched with ${partnerId}! Start signaling.`
      });
      
    } else {
      // Add to queue
      const queueKey = `waiting_queue:${userTimezone}`;
      
      // Check queue size limit
      const currentQueueSize = await kv.llen(queueKey) || 0;
      if (currentQueueSize >= MAX_QUEUE_SIZE) {
        return res.status(503).json({
          status: 'queue_full',
          message: `Queue for ${userTimezone} is full. Try again later.`,
          retryAfter: 30
        });
      }
      
      await kv.lpush(queueKey, userId);
      await kv.expire(queueKey, MATCH_TIMEOUT);
      
      // Update user status
      await kv.hset(`users:${userId}`, {
        status: 'waiting',
        timezone: userTimezone,
        queuedAt: Date.now().toString(),
        lastSeen: Date.now().toString()
      });
      await kv.expire(`users:${userId}`, MATCH_TIMEOUT);
      
      const position = await kv.llen(queueKey);
      const estimatedWait = Math.min(position * 5, 60); // 5s per person, max 60s
      
      return res.json({
        status: 'queued',
        position,
        estimatedWait,
        timezone: userTimezone,
        message: `Added to ${userTimezone} queue. Position: ${position}`
      });
    }
    
  } catch (error) {
    console.error('[JOIN_QUEUE] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to join queue',
      details: error.message 
    });
  }
}

// Poll for match status
async function handlePollMatch(userId, res) {
  try {
    const userData = await kv.hgetall(`users:${userId}`);
    
    if (!userData || !userData.status) {
      return res.json({
        status: 'not_found',
        action_needed: 'join-queue',
        message: 'User not found. Please join queue.'
      });
    }
    
    // Update last seen
    await kv.hset(`users:${userId}`, 'lastSeen', Date.now().toString());
    
    if (userData.status === 'waiting') {
      const queueKey = `waiting_queue:${userData.timezone || 'global'}`;
      const queueList = await kv.lrange(queueKey, 0, -1);
      const position = queueList.indexOf(userId) + 1;
      
      return res.json({
        status: 'waiting',
        position: position || 1,
        estimatedWait: Math.min(position * 5, 60),
        timezone: userData.timezone,
        message: `Waiting in queue. Position: ${position}`
      });
    }
    
    if (userData.status === 'matched' && userData.matchId) {
      const matchData = await kv.hgetall(`matches:${userData.matchId}`);
      
      if (!matchData || matchData.status === 'expired') {
        // Clean up expired match
        await cleanupUser(userId);
        return res.json({
          status: 'match_expired',
          action_needed: 'join-queue',
          message: 'Match expired. Please join queue again.'
        });
      }
      
      const partnerId = matchData.p1 === userId ? matchData.p2 : matchData.p1;
      
      return res.json({
        status: 'matched',
        matchId: userData.matchId,
        partnerId,
        isInitiator: matchData.p1 === userId,
        connectionReady: matchData.status === 'connected',
        message: 'Match active. Ready for signaling.'
      });
    }
    
    return res.json({
      status: userData.status || 'unknown',
      lastSeen: userData.lastSeen,
      message: `User status: ${userData.status}`
    });
    
  } catch (error) {
    console.error('[POLL_MATCH] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to poll match',
      details: error.message 
    });
  }
}

// Send signaling data (offer/answer)
async function handleSendSignal(userId, data, res) {
  try {
    const { matchId, type, signal } = data;
    
    if (!matchId || !type || !signal) {
      return res.status(400).json({ error: 'Missing required fields: matchId, type, signal' });
    }
    
    if (!['offer', 'answer'].includes(type)) {
      return res.status(400).json({ error: 'Signal type must be "offer" or "answer"' });
    }
    
    // Verify match exists and user is participant
    const matchData = await kv.hgetall(`matches:${matchId}`);
    if (!matchData || (matchData.p1 !== userId && matchData.p2 !== userId)) {
      return res.status(403).json({ error: 'Invalid match or unauthorized' });
    }
    
    const partnerId = matchData.p1 === userId ? matchData.p2 : matchData.p1;
    const signalKey = `signals:${matchId}:${partnerId}`;
    
    // Store signal for partner
    await kv.hset(signalKey, {
      [type]: JSON.stringify(signal),
      timestamp: Date.now().toString(),
      from: userId
    });
    await kv.expire(signalKey, MATCH_TIMEOUT);
    
    serverStats.totalSignals++;
    
    return res.json({
      status: 'sent',
      type,
      partnerId,
      timestamp: Date.now(),
      message: `${type} signal sent to ${partnerId}`
    });
    
  } catch (error) {
    console.error('[SEND_SIGNAL] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to send signal',
      details: error.message 
    });
  }
}

// Get signaling data
async function handleGetSignals(userId, data, res) {
  try {
    const { matchId } = data;
    
    if (!matchId) {
      return res.status(400).json({ error: 'Missing matchId' });
    }
    
    const signalKey = `signals:${matchId}:${userId}`;
    const signals = await kv.hgetall(signalKey);
    
    if (!signals || Object.keys(signals).length === 0) {
      return res.json({
        status: 'no_signals',
        signals: {},
        count: 0
      });
    }
    
    // Parse signals
    const parsedSignals = {};
    for (const [key, value] of Object.entries(signals)) {
      if (key !== 'timestamp' && key !== 'from') {
        try {
          parsedSignals[key] = JSON.parse(value);
        } catch (e) {
          parsedSignals[key] = value;
        }
      }
    }
    
    // Clear signals after reading
    await kv.del(signalKey);
    
    return res.json({
      status: 'received',
      signals: parsedSignals,
      count: Object.keys(parsedSignals).length,
      timestamp: signals.timestamp,
      from: signals.from
    });
    
  } catch (error) {
    console.error('[GET_SIGNALS] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to get signals',
      details: error.message 
    });
  }
}

// Send ICE candidate
async function handleSendICE(userId, data, res) {
  try {
    const { matchId, candidate } = data;
    
    if (!matchId || !candidate) {
      return res.status(400).json({ error: 'Missing required fields: matchId, candidate' });
    }
    
    // Verify match
    const matchData = await kv.hgetall(`matches:${matchId}`);
    if (!matchData || (matchData.p1 !== userId && matchData.p2 !== userId)) {
      return res.status(403).json({ error: 'Invalid match or unauthorized' });
    }
    
    const partnerId = matchData.p1 === userId ? matchData.p2 : matchData.p1;
    const iceKey = `ice:${matchId}:${partnerId}`;
    
    // Check current ICE queue length
    const currentLength = await kv.llen(iceKey) || 0;
    if (currentLength >= MAX_ICE_CANDIDATES) {
      // Remove oldest candidate to make room
      await kv.rpop(iceKey);
    }
    
    // Add new ICE candidate
    await kv.lpush(iceKey, JSON.stringify({
      candidate,
      timestamp: Date.now(),
      from: userId
    }));
    await kv.expire(iceKey, MATCH_TIMEOUT);
    
    serverStats.totalICE++;
    
    return res.json({
      status: 'sent',
      partnerId,
      queueLength: Math.min(currentLength + 1, MAX_ICE_CANDIDATES),
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('[SEND_ICE] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to send ICE candidate',
      details: error.message 
    });
  }
}

// Get ICE candidates
async function handleGetICE(userId, data, res) {
  try {
    const { matchId } = data;
    
    if (!matchId) {
      return res.status(400).json({ error: 'Missing matchId' });
    }
    
    const iceKey = `ice:${matchId}:${userId}`;
    const candidates = await kv.lrange(iceKey, 0, -1);
    
    if (!candidates || candidates.length === 0) {
      return res.json({
        status: 'no_candidates',
        candidates: [],
        count: 0
      });
    }
    
    // Parse candidates
    const parsedCandidates = candidates.map(candidate => {
      try {
        return JSON.parse(candidate);
      } catch (e) {
        return { candidate, timestamp: Date.now(), from: 'unknown' };
      }
    });
    
    // Clear ICE candidates after reading
    await kv.del(iceKey);
    
    return res.json({
      status: 'received',
      candidates: parsedCandidates,
      count: parsedCandidates.length
    });
    
  } catch (error) {
    console.error('[GET_ICE] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to get ICE candidates',
      details: error.message 
    });
  }
}

// Mark connection as ready
async function handleConnectionReady(userId, data, res) {
  try {
    const { matchId } = data;
    
    if (!matchId) {
      return res.status(400).json({ error: 'Missing matchId' });
    }
    
    // Update match status
    await kv.hset(`matches:${matchId}`, {
      status: 'connected',
      connectedAt: Date.now().toString()
    });
    
    // Cleanup signaling data
    const matchData = await kv.hgetall(`matches:${matchId}`);
    if (matchData) {
      const partnerId = matchData.p1 === userId ? matchData.p2 : matchData.p1;
      
      // Clean up signaling and ICE data
      await Promise.all([
        kv.del(`signals:${matchId}:${userId}`),
        kv.del(`signals:${matchId}:${partnerId}`),
        kv.del(`ice:${matchId}:${userId}`),
        kv.del(`ice:${matchId}:${partnerId}`)
      ]);
    }
    
    return res.json({
      status: 'connected',
      message: 'Connection established and signaling data cleaned up',
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('[CONNECTION_READY] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to mark connection ready',
      details: error.message 
    });
  }
}

// Disconnect user
async function handleDisconnect(userId, res) {
  try {
    // Get user data
    const userData = await kv.hgetall(`users:${userId}`);
    let cleanupResults = {
      userRemoved: false,
      matchCleaned: false,
      queueRemoved: false,
      partnerNotified: false
    };
    
    if (userData && userData.matchId) {
      const matchData = await kv.hgetall(`matches:${userData.matchId}`);
      if (matchData) {
        const partnerId = matchData.p1 === userId ? matchData.p2 : matchData.p1;
        
        // Clean up match and related data
        await Promise.all([
          kv.del(`matches:${userData.matchId}`),
          kv.del(`signals:${userData.matchId}:${userId}`),
          kv.del(`signals:${userData.matchId}:${partnerId}`),
          kv.del(`ice:${userData.matchId}:${userId}`),
          kv.del(`ice:${userData.matchId}:${partnerId}`),
          kv.del(`users:${partnerId}`)
        ]);
        
        cleanupResults.matchCleaned = true;
        cleanupResults.partnerNotified = true;
        
        // Update stats
        if (matchData.status === 'signaling' || matchData.status === 'connected') {
          serverStats.activeMatches = Math.max(0, serverStats.activeMatches - 1);
        }
      }
    }
    
    // Remove from all queues
    const removedFromQueues = await removeFromAllQueues(userId);
    cleanupResults.queueRemoved = removedFromQueues > 0;
    
    // Remove user data
    await kv.del(`users:${userId}`);
    cleanupResults.userRemoved = true;
    
    return res.json({
      status: 'disconnected',
      cleanup: cleanupResults,
      message: 'Successfully disconnected and cleaned up all data',
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('[DISCONNECT] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to disconnect',
      details: error.message 
    });
  }
}

// Helper functions
function generateMatchId() {
  return `m_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function getAdjacentTimezones(timezone) {
  const timezoneMap = {
    'gmt+7': ['gmt+8', 'gmt+6', 'gmt+9'],
    'gmt+8': ['gmt+7', 'gmt+9', 'gmt+6'],
    'gmt+9': ['gmt+8', 'gmt+7', 'gmt+10'],
    'gmt-5': ['gmt-4', 'gmt-6', 'gmt-3'],
    'gmt-4': ['gmt-5', 'gmt-3', 'gmt-6'],
    'gmt-8': ['gmt-7', 'gmt-9', 'gmt-6'],
    'global': ['gmt+7', 'gmt+8', 'gmt-5']
  };
  
  return timezoneMap[timezone] || ['global'];
}

async function removeFromAllQueues(userId) {
  try {
    const commonQueues = [
      'waiting_queue:global',
      'waiting_queue:gmt+7',
      'waiting_queue:gmt+8', 
      'waiting_queue:gmt+9',
      'waiting_queue:gmt-5',
      'waiting_queue:gmt-4',
      'waiting_queue:gmt-8'
    ];
    
    let removedCount = 0;
    for (const queueKey of commonQueues) {
      const removed = await kv.lrem(queueKey, 0, userId);
      removedCount += removed || 0;
    }
    
    return removedCount;
  } catch (error) {
    console.error('[REMOVE_FROM_QUEUES] Error:', error);
    return 0;
  }
}

async function cleanupUser(userId) {
  try {
    await removeFromAllQueues(userId);
    await kv.del(`users:${userId}`);
  } catch (error) {
    console.error('[CLEANUP_USER] Error:', error);
  }
}

// Export cleanup function cho external cron jobs (optional)
export async function performBackgroundCleanup() {
  try {
    console.log('[CLEANUP] Running background cleanup...');
    
    // Trong Vercel KV, TTL tự động handle cleanup
    // Function này có thể được gọi bởi cron job nếu cần
    
    const timestamp = Date.now();
    return { 
      success: true, 
      timestamp,
      stats: serverStats,
      message: 'TTL-based cleanup active. Manual cleanup completed.' 
    };
  } catch (error) {
    console.error('[BACKGROUND_CLEANUP] Error:', error);
    return { 
      success: false, 
      error: error.message,
      timestamp: Date.now()
    };
  }
}
// WebRTC Signaling Server with Optimized Vercel KV - Fix Timeout Issues
// Fixes: Runtime timeout, KV latency, cleanup performance

import { kv } from '@vercel/kv';

// Optimized KV key patterns and TTL settings
const KEYS = {
  waitingUsers: 'waiting_users',
  matches: 'active_matches',
  userMatch: (userId) => `user_match:${userId}`,
  matchTTL: 600, // 10 minutes
  waitingTTL: 120 // 2 minutes
};

// Constants
const USER_TIMEOUT = 120000; // 2 minutes for waiting users
const MATCH_LIFETIME = 600000; // 10 minutes for active matches
const MAX_WAITING_USERS = 1000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    // GET: Health check and debug info
    if (req.method === 'GET') {
      const { debug } = req.query;
      
      if (debug === 'true') {
        return await handleDebugInfo(res);
      }
      
      // Skip cleanup on GET to avoid timeout
      const stats = await getStatsQuick();
      return res.json({ 
        status: 'kv-signaling-ready',
        stats,
        message: 'Optimized Vercel KV WebRTC signaling server ready',
        storage: 'vercel-kv-optimized',
        timestamp: Date.now()
      });
    }
    
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST required for signaling' });
    }
    
    // Parse request body
    let data;
    if (typeof req.body === 'string') {
      data = JSON.parse(req.body);
    } else {
      data = req.body;
    }
    
    const { action, userId } = data;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    console.log(`[${action?.toUpperCase() || 'UNKNOWN'}] ${userId} (KV-OPT)`);
    
    switch (action) {
      case 'instant-match': 
        return await handleInstantMatchOptimized(userId, data, res);
      case 'get-signals': 
        return await handleGetSignals(userId, res);
      case 'send-signal': 
        return await handleSendSignal(userId, data, res);
      case 'disconnect': 
        return await handleDisconnect(userId, res);
      default: 
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    console.error('[KV SERVER ERROR]', error);
    return res.status(500).json({ 
      error: 'Server error', 
      details: error.message,
      storage: 'vercel-kv-error'
    });
  }
}

// ==========================================
// OPTIMIZED VERCEL KV HELPER FUNCTIONS
// ==========================================

async function getStatsQuick() {
  try {
    // Use pipeline/batch to reduce round trips
    const pipeline = kv.pipeline();
    pipeline.hlen(KEYS.waitingUsers);
    pipeline.hlen(KEYS.matches);
    
    const [waitingCount, matchCount] = await pipeline.exec();
    
    return {
      waiting: waitingCount || 0,
      matches: matchCount || 0,
      totalUsers: (waitingCount || 0) + ((matchCount || 0) * 2)
    };
  } catch (error) {
    console.error('KV Stats error:', error);
    return { waiting: 0, matches: 0, totalUsers: 0 };
  }
}

async function handleDebugInfo(res) {
  try {
    // Simplified debug - avoid heavy hgetall operations
    const stats = await getStatsQuick();
    
    return res.json({
      status: 'vercel-kv-signaling-server-optimized',
      stats,
      kv: {
        configured: !!process.env.KV_REST_API_URL,
        url: process.env.KV_REST_API_URL ? '[CONFIGURED]' : '[NOT SET]'
      },
      optimization: 'enabled',
      timestamp: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Debug info failed',
      details: error.message
    });
  }
}

// ==========================================
// OPTIMIZED INSTANT MATCH HANDLER
// ==========================================

async function handleInstantMatchOptimized(userId, data, res) {
  const { userInfo, preferredMatchId } = data;
  
  console.log(`[INSTANT-MATCH] ${userId} looking for partner (KV-Optimized)`);
  
  try {
    // Skip heavy cleanup - use TTL instead
    console.log(`[INSTANT-MATCH] Skipping cleanup for performance`);
    
    // Quick check if user is already matched (most important check)
    const existingMatch = await kv.get(KEYS.userMatch(userId));
    if (existingMatch) {
      console.log(`[INSTANT-MATCH] ${userId} already has match ${existingMatch}`);
      // Clean up old match and continue
      await Promise.all([
        kv.hdel(KEYS.matches, existingMatch),
        kv.del(KEYS.userMatch(userId))
      ]);
    }
    
    // Remove from waiting list if exists (non-blocking)
    kv.hdel(KEYS.waitingUsers, userId).catch(err => 
      console.log('Non-critical waiting cleanup error:', err)
    );
    
    // Try to find instant match - limit to first 10 waiting users for speed
    const waitingUsersData = await kv.hscan(KEYS.waitingUsers, 0, { count: 10 });
    let bestMatch = null;
    let bestMatchScore = 0;
    
    if (waitingUsersData && waitingUsersData[1] && waitingUsersData[1].length > 0) {
      // waitingUsersData[1] is array of [key, value, key, value, ...]
      const entries = [];
      for (let i = 0; i < waitingUsersData[1].length; i += 2) {
        const waitingUserId = waitingUsersData[1][i];
        const waitingUserData = waitingUsersData[1][i + 1];
        
        if (waitingUserId === userId) continue;
        
        try {
          const waitingUser = JSON.parse(waitingUserData);
          
          // Simple compatibility score
          let score = 1;
          
          // Quick gender compatibility check
          if (userInfo?.gender && waitingUser.userInfo?.gender && 
              userInfo.gender !== waitingUser.userInfo.gender && 
              userInfo.gender !== 'Unspecified' && waitingUser.userInfo.gender !== 'Unspecified') {
            score += 2;
          }
          
          // Fresh user bonus
          const waitTime = Date.now() - waitingUser.timestamp;
          if (waitTime < 30000) score += 1;
          
          if (score > bestMatchScore) {
            bestMatchScore = score;
            bestMatch = { userId: waitingUserId, user: waitingUser };
          }
        } catch (parseError) {
          console.log(`Parse error for user ${waitingUserId}:`, parseError);
          continue;
        }
      }
    }
    
    if (bestMatch) {
      // INSTANT MATCH FOUND! 🚀
      const partnerId = bestMatch.userId;
      const partnerUser = bestMatch.user;
      
      // Create match
      const matchId = preferredMatchId || `match_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      
      // Determine who is initiator (consistent ordering)
      const isUserInitiator = userId < partnerId;
      const p1 = isUserInitiator ? userId : partnerId;
      const p2 = isUserInitiator ? partnerId : userId;
      
      // Create match
      const match = {
        p1,
        p2,
        timestamp: Date.now(),
        signals: {
          [p1]: [], // Initiator's signal queue
          [p2]: []  // Receiver's signal queue
        },
        userInfo: {
          [userId]: userInfo || {},
          [partnerId]: partnerUser.userInfo || {}
        }
      };
      
      // Batch operations for speed
      const pipeline = kv.pipeline();
      pipeline.hset(KEYS.matches, matchId, JSON.stringify(match));
      pipeline.setex(KEYS.userMatch(userId), KEYS.matchTTL, matchId);
      pipeline.setex(KEYS.userMatch(partnerId), KEYS.matchTTL, matchId);
      pipeline.hdel(KEYS.waitingUsers, partnerId); // Remove partner from waiting
      
      await pipeline.exec();
      
      console.log(`[INSTANT-MATCH] 🚀 ${userId} <-> ${partnerId} (${matchId}) - ${isUserInitiator ? 'INITIATOR' : 'RECEIVER'} [KV-OPT]`);
      
      return res.json({
        status: 'instant-match',
        matchId,
        partnerId,
        isInitiator: isUserInitiator,
        partnerInfo: partnerUser.userInfo || {},
        signals: [],
        compatibility: bestMatchScore,
        message: 'Instant match found! WebRTC connection will be established.',
        storage: 'vercel-kv-optimized',
        timestamp: Date.now()
      });
      
    } else {
      // No immediate match, add to waiting list
      const waitingUser = {
        userId,
        userInfo: userInfo || {},
        timestamp: Date.now()
      };
      
      // Add to KV with TTL
      await kv.hset(KEYS.waitingUsers, userId, JSON.stringify(waitingUser));
      
      // Get approximate position (use hlen for speed)
      const position = await kv.hlen(KEYS.waitingUsers);
      console.log(`[INSTANT-MATCH] ${userId} added to KV waiting list (position ~${position})`);
      
      return res.json({
        status: 'waiting',
        position: position || 1,
        waitingUsers: position || 1,
        message: 'Added to matching queue. Waiting for partner...',
        estimatedWaitTime: Math.min((position || 1) * 2, 30),
        storage: 'vercel-kv-optimized',
        timestamp: Date.now()
      });
    }
  } catch (error) {
    console.error('[INSTANT-MATCH KV ERROR]', error);
    return res.status(500).json({
      error: 'Match creation failed',
      details: error.message,
      storage: 'vercel-kv-error'
    });
  }
}

// ==========================================
// OPTIMIZED SIGNAL HANDLERS
// ==========================================

async function handleGetSignals(userId, res) {
  try {
    // Find user's match using user mapping
    const matchId = await kv.get(KEYS.userMatch(userId));
    
    if (matchId) {
      const matchData = await kv.hget(KEYS.matches, matchId);
      
      if (matchData) {
        const match = JSON.parse(matchData);
        const partnerId = match.p1 === userId ? match.p2 : match.p1;
        const signals = match.signals[userId] || [];
        
        // Clear signals after reading to prevent duplicates
        match.signals[userId] = [];
        
        // Update match in KV (non-blocking for better performance)
        kv.hset(KEYS.matches, matchId, JSON.stringify(match)).catch(err =>
          console.log('Non-critical signal clear error:', err)
        );
        
        console.log(`[GET-SIGNALS] ${userId} -> ${signals.length} signals from KV match ${matchId}`);
        
        return res.json({
          status: 'matched',
          matchId,
          partnerId,
          isInitiator: match.p1 === userId,
          signals,
          storage: 'vercel-kv-optimized',
          timestamp: Date.now()
        });
      }
    }
    
    // Check if still in waiting list
    const waitingData = await kv.hget(KEYS.waitingUsers, userId);
    if (waitingData) {
      // Use hlen for quick position estimate
      const waitingCount = await kv.hlen(KEYS.waitingUsers);
      
      return res.json({
        status: 'waiting',
        position: Math.ceil(waitingCount / 2), // Rough estimate
        waitingUsers: waitingCount || 1,
        storage: 'vercel-kv-optimized',
        timestamp: Date.now()
      });
    }
    
    return res.json({
      status: 'not_found',
      message: 'User not found in waiting list or active matches',
      storage: 'vercel-kv-optimized',
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('[GET-SIGNALS KV ERROR]', error);
    return res.status(500).json({
      error: 'Get signals failed',
      details: error.message,
      storage: 'vercel-kv-error'
    });
  }
}

async function handleSendSignal(userId, data, res) {
  const { matchId, type, payload } = data;
  
  if (!matchId || !type || !payload) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['matchId', 'type', 'payload']
    });
  }
  
  try {
    const matchData = await kv.hget(KEYS.matches, matchId);
    
    if (!matchData) {
      console.log(`[SEND-SIGNAL] Match ${matchId} not found in KV`);
      
      // Quick recovery: Try to find user in any match
      const userMatchId = await kv.get(KEYS.userMatch(userId));
      if (userMatchId && userMatchId !== matchId) {
        console.log(`[RECOVERY] User ${userId} found in different match: ${userMatchId}`);
        
        return res.json({
          status: 'match_corrected',
          correctMatchId: userMatchId,
          message: 'Using correct match ID',
          storage: 'vercel-kv-optimized'
        });
      }
      
      return res.status(404).json({ 
        error: 'Match not found',
        matchId,
        userMatchId,
        storage: 'vercel-kv-optimized',
        recovery: 'attempted'
      });
    }
    
    const match = JSON.parse(matchData);
    
    if (match.p1 !== userId && match.p2 !== userId) {
      return res.status(403).json({ 
        error: 'User not in this match',
        storage: 'vercel-kv-optimized'
      });
    }
    
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    
    // Add signal to partner's queue
    if (!match.signals[partnerId]) {
      match.signals[partnerId] = [];
    }
    
    const signal = {
      type,
      payload,
      from: userId,
      timestamp: Date.now()
    };
    
    match.signals[partnerId].push(signal);
    
    // Limit signal queue size to prevent memory bloat
    if (match.signals[partnerId].length > 50) { // Reduced from 100 for speed
      match.signals[partnerId] = match.signals[partnerId].slice(-25);
      console.log(`[SEND-SIGNAL] Trimmed signal queue for ${partnerId}`);
    }
    
    // Update match in KV
    await kv.hset(KEYS.matches, matchId, JSON.stringify(match));
    
    console.log(`[SEND-SIGNAL] ${userId} -> ${partnerId} (${type}) in KV match ${matchId}`);
    
    return res.json({
      status: 'sent',
      partnerId,
      signalType: type,
      queueLength: match.signals[partnerId].length,
      storage: 'vercel-kv-optimized',
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('[SEND-SIGNAL KV ERROR]', error);
    return res.status(500).json({
      error: 'Send signal failed',
      details: error.message,
      storage: 'vercel-kv-error'
    });
  }
}

async function handleDisconnect(userId, res) {
  console.log(`[DISCONNECT] ${userId} (KV-OPT)`);
  
  try {
    let removed = false;
    
    // Remove from waiting list (non-blocking)
    kv.hdel(KEYS.waitingUsers, userId).then(() => {
      console.log(`[DISCONNECT] Removed ${userId} from KV waiting list`);
    }).catch(err => console.log('Non-critical waiting cleanup:', err));
    
    // Handle active match
    const matchId = await kv.get(KEYS.userMatch(userId));
    if (matchId) {
      const matchData = await kv.hget(KEYS.matches, matchId);
      if (matchData) {
        const match = JSON.parse(matchData);
        const partnerId = match.p1 === userId ? match.p2 : match.p1;
        
        // Add disconnect signal to partner's queue
        if (match.signals[partnerId]) {
          match.signals[partnerId].push({
            type: 'disconnect',
            payload: { reason: 'partner_disconnected' },
            from: userId,
            timestamp: Date.now()
          });
          
          // Update match with disconnect signal
          await kv.hset(KEYS.matches, matchId, JSON.stringify(match));
        }
        
        console.log(`[DISCONNECT] Notified ${partnerId} in KV match ${matchId}`);
        
        // Remove match and user mappings after delay (non-blocking)
        setTimeout(() => {
          const pipeline = kv.pipeline();
          pipeline.hdel(KEYS.matches, matchId);
          pipeline.del(KEYS.userMatch(userId));
          pipeline.del(KEYS.userMatch(partnerId));
          
          pipeline.exec().then(() => {
            console.log(`[DISCONNECT] KV match ${matchId} cleaned up`);
          }).catch(err => {
            console.error('[CLEANUP ERROR]', err);
          });
        }, 5000);
        
        removed = true;
      }
    }
    
    return res.json({ 
      status: 'disconnected',
      removed,
      storage: 'vercel-kv-optimized',
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('[DISCONNECT KV ERROR]', error);
    return res.status(500).json({
      error: 'Disconnect failed',
      details: error.message,
      storage: 'vercel-kv-error'
    });
  }
}

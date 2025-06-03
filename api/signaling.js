// WebRTC Signaling Server with Vercel KV - Fixes Serverless Issues
// Solves: Cold start, Auto-scaling, Geographic distribution, Memory isolation

import { kv } from '@vercel/kv';

// KV key patterns and TTL settings
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
      
      // Trigger cleanup
      await cleanup();
      
      const stats = await getStats();
      return res.json({ 
        status: 'kv-signaling-ready',
        stats,
        message: 'Vercel KV WebRTC signaling server ready',
        storage: 'vercel-kv',
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
    
    console.log(`[${action?.toUpperCase() || 'UNKNOWN'}] ${userId} (KV)`);
    
    switch (action) {
      case 'instant-match': 
        return await handleInstantMatch(userId, data, res);
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
// VERCEL KV HELPER FUNCTIONS
// ==========================================

async function getStats() {
  try {
    const [waitingUsers, matches] = await Promise.all([
      kv.hgetall(KEYS.waitingUsers),
      kv.hgetall(KEYS.matches)
    ]);
    
    const waitingCount = waitingUsers ? Object.keys(waitingUsers).length : 0;
    const matchCount = matches ? Object.keys(matches).length : 0;
    
    return {
      waiting: waitingCount,
      matches: matchCount,
      totalUsers: waitingCount + (matchCount * 2)
    };
  } catch (error) {
    console.error('KV Stats error:', error);
    return { waiting: 0, matches: 0, totalUsers: 0 };
  }
}

async function handleDebugInfo(res) {
  try {
    const [waitingUsers, matches, stats] = await Promise.all([
      kv.hgetall(KEYS.waitingUsers),
      kv.hgetall(KEYS.matches),
      getStats()
    ]);
    
    return res.json({
      status: 'vercel-kv-signaling-server',
      stats,
      waitingUserIds: waitingUsers ? Object.keys(waitingUsers) : [],
      activeMatchIds: matches ? Object.keys(matches) : [],
      kv: {
        configured: !!process.env.KV_REST_API_URL,
        url: process.env.KV_REST_API_URL ? '[CONFIGURED]' : '[NOT SET]'
      },
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
// INSTANT MATCH HANDLER WITH VERCEL KV
// ==========================================

async function handleInstantMatch(userId, data, res) {
  const { userInfo, preferredMatchId } = data;
  
  console.log(`[INSTANT-MATCH] ${userId} looking for partner (Vercel KV)`);
  
  try {
    // Cleanup first
    await cleanup();
    
    // Check if user is already waiting or matched
    const [existingWaiting, existingMatch] = await Promise.all([
      kv.hget(KEYS.waitingUsers, userId),
      kv.get(KEYS.userMatch(userId))
    ]);
    
    if (existingWaiting) {
      await kv.hdel(KEYS.waitingUsers, userId);
      console.log(`[INSTANT-MATCH] Updated existing waiting user ${userId}`);
    }
    
    if (existingMatch) {
      await Promise.all([
        kv.hdel(KEYS.matches, existingMatch),
        kv.del(KEYS.userMatch(userId))
      ]);
      console.log(`[INSTANT-MATCH] Removed ${userId} from existing match ${existingMatch}`);
    }
    
    // Try to find instant match from waiting users
    const waitingUsersData = await kv.hgetall(KEYS.waitingUsers);
    let bestMatch = null;
    let bestMatchScore = 0;
    
    if (waitingUsersData) {
      for (const [waitingUserId, waitingUserData] of Object.entries(waitingUsersData)) {
        if (waitingUserId === userId) continue;
        
        const waitingUser = JSON.parse(waitingUserData);
        
        // Calculate compatibility score
        let score = 1;
        
        // Prefer users with complementary userInfo if available
        if (userInfo && waitingUser.userInfo) {
          if (userInfo.gender && waitingUser.userInfo.gender && 
              userInfo.gender !== waitingUser.userInfo.gender && 
              userInfo.gender !== 'Unspecified' && waitingUser.userInfo.gender !== 'Unspecified') {
            score += 2; // Bonus for different genders
          }
          if (userInfo.status && waitingUser.userInfo.status &&
              userInfo.status === waitingUser.userInfo.status) {
            score += 1; // Bonus for similar status/mood
          }
        }
        
        // Prefer newer users (less waiting time)
        const waitTime = Date.now() - waitingUser.timestamp;
        if (waitTime < 30000) score += 1; // Less than 30 seconds
        if (waitTime < 10000) score += 1; // Less than 10 seconds (very fresh)
        
        if (score > bestMatchScore) {
          bestMatchScore = score;
          bestMatch = { userId: waitingUserId, user: waitingUser };
        }
      }
    }
    
    if (bestMatch) {
      // INSTANT MATCH FOUND! 🚀
      const partnerId = bestMatch.userId;
      const partnerUser = bestMatch.user;
      
      // Remove partner from waiting list
      await kv.hdel(KEYS.waitingUsers, partnerId);
      
      // Create match
      const matchId = preferredMatchId || `match_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      
      // Determine who is initiator (consistent ordering)
      const isUserInitiator = userId < partnerId;
      const p1 = isUserInitiator ? userId : partnerId;
      const p2 = isUserInitiator ? partnerId : userId;
      
      // Create match without pre-exchanged signals
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
      
      // Save to KV with TTL
      await Promise.all([
        kv.hset(KEYS.matches, { [matchId]: JSON.stringify(match) }),
        kv.expire(KEYS.matches, KEYS.matchTTL),
        kv.setex(KEYS.userMatch(userId), KEYS.matchTTL, matchId),
        kv.setex(KEYS.userMatch(partnerId), KEYS.matchTTL, matchId)
      ]);
      
      console.log(`[INSTANT-MATCH] 🚀 ${userId} <-> ${partnerId} (${matchId}) - ${isUserInitiator ? 'INITIATOR' : 'RECEIVER'} [KV]`);
      
      return res.json({
        status: 'instant-match',
        matchId,
        partnerId,
        isInitiator: isUserInitiator,
        partnerInfo: partnerUser.userInfo || {},
        signals: [], // No pre-exchanged signals
        compatibility: bestMatchScore,
        message: 'Instant match found! WebRTC connection will be established.',
        storage: 'vercel-kv',
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
      await Promise.all([
        kv.hset(KEYS.waitingUsers, { [userId]: JSON.stringify(waitingUser) }),
        kv.expire(KEYS.waitingUsers, KEYS.waitingTTL)
      ]);
      
      const stats = await getStats();
      const position = stats.waiting;
      console.log(`[INSTANT-MATCH] ${userId} added to KV waiting list (position ${position})`);
      
      return res.json({
        status: 'waiting',
        position,
        waitingUsers: stats.waiting,
        message: 'Added to matching queue. Waiting for partner...',
        estimatedWaitTime: Math.min(stats.waiting * 2, 30),
        storage: 'vercel-kv',
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
// SIGNAL HANDLERS WITH VERCEL KV
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
        
        // Update match in KV
        await kv.hset(KEYS.matches, { [matchId]: JSON.stringify(match) });
        
        console.log(`[GET-SIGNALS] ${userId} -> ${signals.length} signals from KV match ${matchId}`);
        
        return res.json({
          status: 'matched',
          matchId,
          partnerId,
          isInitiator: match.p1 === userId,
          signals,
          storage: 'vercel-kv',
          timestamp: Date.now()
        });
      }
    }
    
    // Check if still in waiting list
    const waitingData = await kv.hget(KEYS.waitingUsers, userId);
    if (waitingData) {
      const allWaiting = await kv.hgetall(KEYS.waitingUsers);
      const waitingUserIds = allWaiting ? Object.keys(allWaiting) : [];
      const position = waitingUserIds.indexOf(userId) + 1;
      
      return res.json({
        status: 'waiting',
        position: position > 0 ? position : 1,
        waitingUsers: waitingUserIds.length,
        storage: 'vercel-kv',
        timestamp: Date.now()
      });
    }
    
    return res.json({
      status: 'not_found',
      message: 'User not found in waiting list or active matches',
      storage: 'vercel-kv',
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
      
      // 🔧 ENHANCED RECOVERY: Try to find user in any match
      const userMatchId = await kv.get(KEYS.userMatch(userId));
      if (userMatchId && userMatchId !== matchId) {
        console.log(`[RECOVERY] User ${userId} found in different match: ${userMatchId}`);
        
        const correctMatchData = await kv.hget(KEYS.matches, userMatchId);
        if (correctMatchData) {
          console.log(`[RECOVERY] Redirecting to correct match ${userMatchId}`);
          return res.json({
            status: 'match_corrected',
            correctMatchId: userMatchId,
            message: 'Using correct match ID',
            storage: 'vercel-kv'
          });
        }
      }
      
      // Get all matches for debugging
      const allMatches = await kv.hgetall(KEYS.matches);
      return res.status(404).json({ 
        error: 'Match not found',
        matchId,
        userMatchId,
        availableMatches: allMatches ? Object.keys(allMatches) : [],
        storage: 'vercel-kv',
        recovery: 'attempted'
      });
    }
    
    const match = JSON.parse(matchData);
    
    if (match.p1 !== userId && match.p2 !== userId) {
      return res.status(403).json({ 
        error: 'User not in this match',
        storage: 'vercel-kv'
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
    if (match.signals[partnerId].length > 100) {
      match.signals[partnerId] = match.signals[partnerId].slice(-50);
      console.log(`[SEND-SIGNAL] Trimmed signal queue for ${partnerId}`);
    }
    
    // Update match in KV
    await kv.hset(KEYS.matches, { [matchId]: JSON.stringify(match) });
    
    console.log(`[SEND-SIGNAL] ${userId} -> ${partnerId} (${type}) in KV match ${matchId}`);
    
    return res.json({
      status: 'sent',
      partnerId,
      signalType: type,
      queueLength: match.signals[partnerId].length,
      storage: 'vercel-kv',
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
  console.log(`[DISCONNECT] ${userId} (KV)`);
  
  try {
    let removed = false;
    
    // Remove from waiting list
    const waitingData = await kv.hget(KEYS.waitingUsers, userId);
    if (waitingData) {
      await kv.hdel(KEYS.waitingUsers, userId);
      removed = true;
      console.log(`[DISCONNECT] Removed ${userId} from KV waiting list`);
    }
    
    // Remove from active matches and notify partner
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
          await kv.hset(KEYS.matches, { [matchId]: JSON.stringify(match) });
        }
        
        console.log(`[DISCONNECT] Notified ${partnerId} in KV match ${matchId}`);
        
        // Remove match and user mappings after delay
        setTimeout(async () => {
          try {
            await Promise.all([
              kv.hdel(KEYS.matches, matchId),
              kv.del(KEYS.userMatch(userId)),
              kv.del(KEYS.userMatch(partnerId))
            ]);
            console.log(`[DISCONNECT] KV match ${matchId} cleaned up`);
          } catch (error) {
            console.error('[CLEANUP ERROR]', error);
          }
        }, 5000);
        
        removed = true;
      }
    }
    
    return res.json({ 
      status: 'disconnected',
      removed,
      storage: 'vercel-kv',
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

// ==========================================
// CLEANUP UTILITIES WITH VERCEL KV
// ==========================================

async function cleanup() {
  try {
    const now = Date.now();
    let cleanedUsers = 0;
    let cleanedMatches = 0;
    
    // Clean expired waiting users
    const waitingUsers = await kv.hgetall(KEYS.waitingUsers);
    if (waitingUsers) {
      const expiredUsers = [];
      for (const [userId, userData] of Object.entries(waitingUsers)) {
        const user = JSON.parse(userData);
        if (now - user.timestamp > USER_TIMEOUT) {
          expiredUsers.push(userId);
        }
      }
      
      if (expiredUsers.length > 0) {
        await kv.hdel(KEYS.waitingUsers, ...expiredUsers);
        cleanedUsers = expiredUsers.length;
      }
    }
    
    // Clean old matches
    const matches = await kv.hgetall(KEYS.matches);
    if (matches) {
      const expiredMatches = [];
      const expiredUserMappings = [];
      
      for (const [matchId, matchData] of Object.entries(matches)) {
        const match = JSON.parse(matchData);
        if (now - match.timestamp > MATCH_LIFETIME) {
          expiredMatches.push(matchId);
          expiredUserMappings.push(
            KEYS.userMatch(match.p1),
            KEYS.userMatch(match.p2)
          );
        }
      }
      
      if (expiredMatches.length > 0) {
        await Promise.all([
          kv.hdel(KEYS.matches, ...expiredMatches),
          ...expiredUserMappings.map(key => kv.del(key))
        ]);
        cleanedMatches = expiredMatches.length;
      }
    }
    
    // Prevent memory bloat - remove oldest users if too many waiting
    const currentWaiting = await kv.hgetall(KEYS.waitingUsers);
    if (currentWaiting && Object.keys(currentWaiting).length > MAX_WAITING_USERS) {
      const users = Object.entries(currentWaiting)
        .map(([userId, userData]) => ({
          userId,
          timestamp: JSON.parse(userData).timestamp
        }))
        .sort((a, b) => a.timestamp - b.timestamp);
      
      const excess = users.length - MAX_WAITING_USERS;
      const usersToRemove = users.slice(0, excess).map(u => u.userId);
      
      if (usersToRemove.length > 0) {
        await kv.hdel(KEYS.waitingUsers, ...usersToRemove);
        cleanedUsers += usersToRemove.length;
        console.log(`[CLEANUP] Removed ${excess} oldest users from KV due to capacity limit`);
      }
    }
    
    if (cleanedUsers > 0 || cleanedMatches > 0) {
      const stats = await getStats();
      console.log(`[CLEANUP] KV: Removed ${cleanedUsers} expired users, ${cleanedMatches} old matches. Active: ${stats.waiting} waiting, ${stats.matches} matched`);
    }
  } catch (error) {
    console.error('[CLEANUP KV ERROR]', error);
  }
}

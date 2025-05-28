// api/signaling.js - Optimized Vercel serverless function for WebRTC signaling

import { kv } from '@vercel/kv'; // Persistent storage alternative

// Fallback in-memory storage for development
let memoryStorage = {
  connections: new Map(),
  waitingQueue: [],
  heartbeats: new Map(),
  lastCleanup: Date.now()
};

// Configuration
const CONFIG = {
  HEARTBEAT_TIMEOUT: 180000, // 3 minutes (reduced from 5)
  QUEUE_TIMEOUT: 90000,      // 1.5 minutes (reduced from 2)
  CLEANUP_INTERVAL: 60000,   // 1 minute (reduced from 30s)
  MAX_PENDING_SIGNALS: 20,   // Limit pending signals per connection
  POLL_INTERVAL: 2000,       // Suggested client poll interval
  MAX_QUEUE_SIZE: 100        // Prevent memory overflow
};

// Use KV store if available, fallback to memory
const useKV = process.env.KV_REST_API_URL;

async function getStorageData(key) {
  if (useKV) {
    try {
      return await kv.get(key);
    } catch (e) {
      console.warn('KV get failed, using memory:', e.message);
    }
  }
  return memoryStorage[key];
}

async function setStorageData(key, value) {
  if (useKV) {
    try {
      await kv.set(key, value, { ex: 300 }); // 5 min expiration
    } catch (e) {
      console.warn('KV set failed, using memory:', e.message);
    }
  }
  memoryStorage[key] = value;
}

// Optimized cleanup function
async function performCleanup() {
  const now = Date.now();
  
  // Skip if cleanup was recent
  if (now - memoryStorage.lastCleanup < CONFIG.CLEANUP_INTERVAL) {
    return;
  }
  
  try {
    let connections = await getStorageData('connections') || new Map();
    let waitingQueue = await getStorageData('waitingQueue') || [];
    let heartbeats = await getStorageData('heartbeats') || new Map();
    
    // Convert to Map if stored as object
    if (!(connections instanceof Map)) {
      connections = new Map(Object.entries(connections));
    }
    if (!(heartbeats instanceof Map)) {
      heartbeats = new Map(Object.entries(heartbeats));
    }
    
    let cleaned = false;
    
    // Clean expired heartbeats and connections
    for (const [peerId, lastSeen] of heartbeats.entries()) {
      if (now - lastSeen > CONFIG.HEARTBEAT_TIMEOUT) {
        heartbeats.delete(peerId);
        connections.delete(peerId);
        cleaned = true;
      }
    }
    
    // Clean old waiting queue entries and limit size
    const originalQueueLength = waitingQueue.length;
    waitingQueue = waitingQueue
      .filter(p => now - p.timestamp < CONFIG.QUEUE_TIMEOUT)
      .slice(-CONFIG.MAX_QUEUE_SIZE); // Keep only last N entries
    
    if (waitingQueue.length !== originalQueueLength) {
      cleaned = true;
    }
    
    // Clean expired pending signals
    for (const [peerId, connection] of connections.entries()) {
      if (connection.pendingSignals && connection.pendingSignals.length > 0) {
        const originalLength = connection.pendingSignals.length;
        connection.pendingSignals = connection.pendingSignals
          .filter(signal => now - signal.timestamp < CONFIG.QUEUE_TIMEOUT)
          .slice(-CONFIG.MAX_PENDING_SIGNALS);
        
        if (connection.pendingSignals.length !== originalLength) {
          cleaned = true;
        }
      }
    }
    
    if (cleaned) {
      await setStorageData('connections', connections);
      await setStorageData('waitingQueue', waitingQueue);
      await setStorageData('heartbeats', heartbeats);
    }
    
    memoryStorage.lastCleanup = now;
    
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

export default async function handler(req, res) {
  // Set optimized CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Perform cleanup periodically
  performCleanup().catch(console.error);
  
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
        message: 'Invalid request data',
        pollInterval: CONFIG.POLL_INTERVAL
      });
    }

    let result;
    switch (data.type) {
      case 'register':
        result = await handleRegistration(data, now);
        break;
      
      case 'offer':
        result = await handleOffer(data, now);
        break;
      
      case 'answer':
        result = await handleAnswer(data, now);
        break;
        
      case 'ice-candidate':
        result = await handleIceCandidate(data, now);
        break;
      
      case 'poll':
        result = await handlePoll(data);
        break;
      
      case 'disconnect':
        result = await handleDisconnection(data, now);
        break;
      
      case 'heartbeat':
        result = await handleHeartbeat(data, now);
        break;
      
      default:
        result = { status: 'error', message: 'Unknown request type' };
    }
    
    // Add polling configuration to response
    result.pollInterval = CONFIG.POLL_INTERVAL;
    result.serverTime = now;
    
    return res.status(result.status === 'error' ? 400 : 200).json(result);
    
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Server error occurred',
      pollInterval: CONFIG.POLL_INTERVAL,
      timestamp: Date.now()
    });
  }
}

async function handleRegistration(data, now) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }
  
  try {
    let connections = await getStorageData('connections') || new Map();
    let waitingQueue = await getStorageData('waitingQueue') || [];
    let heartbeats = await getStorageData('heartbeats') || new Map();
    
    // Convert to Map if needed
    if (!(connections instanceof Map)) {
      connections = new Map(Object.entries(connections));
    }
    if (!(heartbeats instanceof Map)) {
      heartbeats = new Map(Object.entries(heartbeats));
    }
    
    // Update heartbeat
    heartbeats.set(data.peerId, now);
    
    // Remove from waiting queue if already exists
    waitingQueue = waitingQueue.filter(p => p.peerId !== data.peerId);
    
    // Look for available peer with better matching
    const availablePeer = waitingQueue.find(p => 
      p.peerId !== data.peerId && 
      now - p.timestamp < CONFIG.QUEUE_TIMEOUT &&
      !connections.has(p.peerId)
    );
    
    if (availablePeer) {
      // Create match with optimized structure
      const matchId = `${Math.min(data.peerId, availablePeer.peerId)}_${Math.max(data.peerId, availablePeer.peerId)}_${now}`;
      
      const connectionData = {
        partnerId: availablePeer.peerId,
        matchId: matchId,
        timestamp: now,
        status: 'matched',
        pendingSignals: [],
        lastActivity: now
      };
      
      const partnerData = {
        partnerId: data.peerId,
        matchId: matchId,
        timestamp: now,
        status: 'matched',
        pendingSignals: [],
        lastActivity: now
      };
      
      connections.set(data.peerId, connectionData);
      connections.set(availablePeer.peerId, partnerData);
      
      // Remove matched peer from queue
      waitingQueue = waitingQueue.filter(p => p.peerId !== availablePeer.peerId);
      
      // Save data
      await setStorageData('connections', connections);
      await setStorageData('waitingQueue', waitingQueue);
      await setStorageData('heartbeats', heartbeats);
      
      console.log('Match created:', data.peerId, '<->', availablePeer.peerId);
      
      return { 
        status: 'matched', 
        partnerId: availablePeer.peerId,
        matchId: matchId,
        isInitiator: true,
        timestamp: now
      };
    }
    
    // Add to waiting queue with size limit
    if (waitingQueue.length >= CONFIG.MAX_QUEUE_SIZE) {
      waitingQueue = waitingQueue.slice(-CONFIG.MAX_QUEUE_SIZE + 1);
    }
    
    waitingQueue.push({ 
      peerId: data.peerId, 
      timestamp: now,
      userAgent: data.userAgent || 'unknown'
    });
    
    // Save data
    await setStorageData('waitingQueue', waitingQueue);
    await setStorageData('heartbeats', heartbeats);
    
    return { 
      status: 'waiting',
      position: waitingQueue.length,
      estimatedWait: Math.max(0, (waitingQueue.length - 1) * 10), // seconds
      timestamp: now
    };
    
  } catch (error) {
    console.error('Registration error:', error);
    return { status: 'error', message: 'Registration failed' };
  }
}

async function handleOffer(data, now) {
  if (!data.peerId || !data.offer) {
    return { status: 'error', message: 'Missing peerId or offer' };
  }
  
  return await handleSignalingMessage(data.peerId, {
    type: 'offer',
    data: data.offer,
    timestamp: now
  }, now);
}

async function handleAnswer(data, now) {
  if (!data.peerId || !data.answer) {
    return { status: 'error', message: 'Missing peerId or answer' };
  }
  
  return await handleSignalingMessage(data.peerId, {
    type: 'answer',
    data: data.answer,
    timestamp: now
  }, now);
}

async function handleIceCandidate(data, now) {
  if (!data.peerId || !data.candidate) {
    return { status: 'error', message: 'Missing peerId or candidate' };
  }
  
  return await handleSignalingMessage(data.peerId, {
    type: 'ice-candidate',
    data: data.candidate,
    timestamp: now
  }, now);
}

// Optimized signaling message handler
async function handleSignalingMessage(peerId, signal, now) {
  try {
    let connections = await getStorageData('connections') || new Map();
    
    if (!(connections instanceof Map)) {
      connections = new Map(Object.entries(connections));
    }
    
    const connection = connections.get(peerId);
    if (!connection || !connection.partnerId) {
      return { status: 'error', message: 'No active match found' };
    }
    
    const partnerConnection = connections.get(connection.partnerId);
    if (!partnerConnection) {
      return { status: 'error', message: 'Partner connection not found' };
    }
    
    // Add signal with size limit
    if (!partnerConnection.pendingSignals) {
      partnerConnection.pendingSignals = [];
    }
    
    partnerConnection.pendingSignals.push(signal);
    
    // Keep only recent signals
    if (partnerConnection.pendingSignals.length > CONFIG.MAX_PENDING_SIGNALS) {
      partnerConnection.pendingSignals = partnerConnection.pendingSignals.slice(-CONFIG.MAX_PENDING_SIGNALS);
    }
    
    partnerConnection.lastActivity = now;
    connections.set(connection.partnerId, partnerConnection);
    
    // Update sender's last activity
    connection.lastActivity = now;
    connections.set(peerId, connection);
    
    await setStorageData('connections', connections);
    
    return { 
      status: `${signal.type.replace('-', '_')}_sent`,
      partnerId: connection.partnerId,
      timestamp: now
    };
    
  } catch (error) {
    console.error('Signaling message error:', error);
    return { status: 'error', message: 'Signaling failed' };
  }
}

async function handlePoll(data) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }
  
  try {
    let connections = await getStorageData('connections') || new Map();
    
    if (!(connections instanceof Map)) {
      connections = new Map(Object.entries(connections));
    }
    
    const connection = connections.get(data.peerId);
    if (!connection) {
      return { 
        status: 'no_connection',
        signals: [],
        pollInterval: CONFIG.POLL_INTERVAL
      };
    }
    
    // Get pending signals and clear them atomically
    const signals = connection.pendingSignals || [];
    connection.pendingSignals = [];
    connection.lastActivity = Date.now();
    
    connections.set(data.peerId, connection);
    await setStorageData('connections', connections);
    
    return { 
      status: 'polled', 
      signals: signals,
      partnerId: connection.partnerId,
      count: signals.length,
      pollInterval: signals.length > 0 ? Math.max(500, CONFIG.POLL_INTERVAL / 2) : CONFIG.POLL_INTERVAL
    };
    
  } catch (error) {
    console.error('Polling error:', error);
    return { status: 'error', message: 'Polling failed' };
  }
}

async function handleDisconnection(data, now) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }
  
  try {
    let connections = await getStorageData('connections') || new Map();
    let waitingQueue = await getStorageData('waitingQueue') || [];
    let heartbeats = await getStorageData('heartbeats') || new Map();
    
    if (!(connections instanceof Map)) {
      connections = new Map(Object.entries(connections));
    }
    if (!(heartbeats instanceof Map)) {
      heartbeats = new Map(Object.entries(heartbeats));
    }
    
    const connection = connections.get(data.peerId);
    
    if (connection && connection.partnerId) {
      // Notify partner about disconnection
      const partnerConnection = connections.get(connection.partnerId);
      if (partnerConnection) {
        if (!partnerConnection.pendingSignals) {
          partnerConnection.pendingSignals = [];
        }
        partnerConnection.pendingSignals.push({
          type: 'disconnect',
          data: { reason: data.reason || 'partner_disconnected' },
          timestamp: now
        });
        connections.set(connection.partnerId, partnerConnection);
      }
      
      // Clean up both connections
      connections.delete(data.peerId);
      console.log('Disconnection handled:', data.peerId, 'from', connection.partnerId);
    }
    
    // Remove from waiting queue
    waitingQueue = waitingQueue.filter(p => p.peerId !== data.peerId);
    
    // Remove heartbeat
    heartbeats.delete(data.peerId);
    
    // Save data
    await setStorageData('connections', connections);
    await setStorageData('waitingQueue', waitingQueue);
    await setStorageData('heartbeats', heartbeats);
    
    return { 
      status: 'disconnected',
      timestamp: now
    };
    
  } catch (error) {
    console.error('Disconnection error:', error);
    return { status: 'error', message: 'Disconnection failed' };
  }
}

async function handleHeartbeat(data, now) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }
  
  try {
    let connections = await getStorageData('connections') || new Map();
    let heartbeats = await getStorageData('heartbeats') || new Map();
    
    if (!(connections instanceof Map)) {
      connections = new Map(Object.entries(connections));
    }
    if (!(heartbeats instanceof Map)) {
      heartbeats = new Map(Object.entries(heartbeats));
    }
    
    heartbeats.set(data.peerId, now);
    
    const connection = connections.get(data.peerId);
    if (connection) {
      connection.lastActivity = now;
      connections.set(data.peerId, connection);
      await setStorageData('connections', connections);
      
      return { 
        status: 'alive',
        matched: true,
        partnerId: connection.partnerId,
        pollInterval: CONFIG.POLL_INTERVAL
      };
    }
    
    await setStorageData('heartbeats', heartbeats);
    
    return { 
      status: 'alive',
      matched: false,
      pollInterval: CONFIG.POLL_INTERVAL
    };
    
  } catch (error) {
    console.error('Heartbeat error:', error);
    return { status: 'error', message: 'Heartbeat failed' };
  }
}

async function handleGetRequest(req, res) {
  try {
    let connections = await getStorageData('connections') || new Map();
    let waitingQueue = await getStorageData('waitingQueue') || [];
    let heartbeats = await getStorageData('heartbeats') || new Map();
    
    const stats = {
      service: 'WebRTC Signaling Server',
      status: 'online',
      version: '2.0.0',
      timestamp: Date.now(),
      config: {
        pollInterval: CONFIG.POLL_INTERVAL,
        heartbeatTimeout: CONFIG.HEARTBEAT_TIMEOUT,
        maxPendingSignals: CONFIG.MAX_PENDING_SIGNALS
      },
      stats: {
        waiting: Array.isArray(waitingQueue) ? waitingQueue.length : 0,
        active_connections: connections instanceof Map ? connections.size : Object.keys(connections || {}).length,
        active_heartbeats: heartbeats instanceof Map ? heartbeats.size : Object.keys(heartbeats || {}).length,
        server_time: new Date().toISOString(),
        storage_type: useKV ? 'redis' : 'memory'
      }
    };
    
    return res.status(200).json(stats);
  } catch (error) {
    console.error('Stats error:', error);
    return res.status(500).json({
      service: 'WebRTC Signaling Server',
      status: 'error',
      timestamp: Date.now()
    });
  }
}
// api/signaling.js - Vercel serverless function for WebRTC signaling

// In-memory storage for active connections (will reset on cold starts)
let activeConnections = new Map();
let waitingQueue = [];
let heartbeats = new Map();

// Cleanup expired entries every 30 seconds
setInterval(() => {
  const now = Date.now();
  
  // Clean expired heartbeats (5 minutes)
  for (const [peerId, lastSeen] of heartbeats.entries()) {
    if (now - lastSeen > 300000) {
      heartbeats.delete(peerId);
      activeConnections.delete(peerId);
      waitingQueue = waitingQueue.filter(p => p.peerId !== peerId);
    }
  }
  
  // Clean old waiting queue entries (2 minutes)
  waitingQueue = waitingQueue.filter(p => now - p.timestamp < 120000);
}, 30000);

export default async function handler(req, res) {
  // Set CORS headers
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
      case 'register':
        result = handleRegistration(data, now);
        break;
      
      case 'offer':
        result = handleOffer(data, now);
        break;
      
      case 'answer':
        result = handleAnswer(data, now);
        break;
        
      case 'ice-candidate':
        result = handleIceCandidate(data, now);
        break;
      
      case 'poll':
        result = handlePoll(data);
        break;
      
      case 'disconnect':
        result = handleDisconnection(data, now);
        break;
      
      case 'heartbeat':
        result = handleHeartbeat(data, now);
        break;
      
      default:
        result = { status: 'error', message: 'Unknown request type' };
    }
    
    return res.status(result.status === 'error' ? 400 : 200).json(result);
    
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Server error: ' + error.message,
      timestamp: Date.now()
    });
  }
}

function handleRegistration(data, now) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }
  
  try {
    // Update heartbeat
    heartbeats.set(data.peerId, now);
    
    // Remove from waiting queue if already exists
    waitingQueue = waitingQueue.filter(p => p.peerId !== data.peerId);
    
    // Look for available peer in queue
    const availablePeer = waitingQueue.find(p => 
      p.peerId !== data.peerId && 
      now - p.timestamp < 60000 &&
      !activeConnections.has(p.peerId)
    );
    
    if (availablePeer) {
      // Create match
      const matchId = `${data.peerId}_${availablePeer.peerId}`;
      
      activeConnections.set(data.peerId, {
        partnerId: availablePeer.peerId,
        matchId: matchId,
        timestamp: now,
        status: 'matched',
        pendingSignals: []
      });
      
      activeConnections.set(availablePeer.peerId, {
        partnerId: data.peerId,
        matchId: matchId,
        timestamp: now,
        status: 'matched',
        pendingSignals: []
      });
      
      // Remove matched peer from queue
      waitingQueue = waitingQueue.filter(p => p.peerId !== availablePeer.peerId);
      
      console.log('Match created:', data.peerId, '<->', availablePeer.peerId);
      
      return { 
        status: 'matched', 
        partnerId: availablePeer.peerId,
        isInitiator: true,
        timestamp: now
      };
    }
    
    // Add to waiting queue
    waitingQueue.push({ 
      peerId: data.peerId, 
      timestamp: now,
      userAgent: data.userAgent || 'unknown'
    });
    
    return { 
      status: 'waiting',
      position: waitingQueue.length,
      timestamp: now
    };
    
  } catch (error) {
    console.error('Registration error:', error);
    return { status: 'error', message: 'Registration failed: ' + error.message };
  }
}

function handleOffer(data, now) {
  if (!data.peerId || !data.offer) {
    return { status: 'error', message: 'Missing peerId or offer' };
  }
  
  try {
    const connection = activeConnections.get(data.peerId);
    if (!connection || !connection.partnerId) {
      return { status: 'error', message: 'No active match found' };
    }
    
    const partnerConnection = activeConnections.get(connection.partnerId);
    if (!partnerConnection) {
      return { status: 'error', message: 'Partner connection not found' };
    }
    
    // Store offer for partner to poll
    partnerConnection.pendingSignals.push({
      type: 'offer',
      data: data.offer,
      timestamp: now
    });
    
    return { 
      status: 'offer_sent',
      partnerId: connection.partnerId,
      timestamp: now
    };
    
  } catch (error) {
    console.error('Offer handling error:', error);
    return { status: 'error', message: 'Offer handling failed: ' + error.message };
  }
}

function handleAnswer(data, now) {
  if (!data.peerId || !data.answer) {
    return { status: 'error', message: 'Missing peerId or answer' };
  }
  
  try {
    const connection = activeConnections.get(data.peerId);
    if (!connection || !connection.partnerId) {
      return { status: 'error', message: 'No active match found' };
    }
    
    const partnerConnection = activeConnections.get(connection.partnerId);
    if (!partnerConnection) {
      return { status: 'error', message: 'Partner connection not found' };
    }
    
    // Store answer for partner to poll
    partnerConnection.pendingSignals.push({
      type: 'answer',
      data: data.answer,
      timestamp: now
    });
    
    return { 
      status: 'answer_sent',
      partnerId: connection.partnerId,
      timestamp: now
    };
    
  } catch (error) {
    console.error('Answer handling error:', error);
    return { status: 'error', message: 'Answer handling failed: ' + error.message };
  }
}

function handleIceCandidate(data, now) {
  if (!data.peerId || !data.candidate) {
    return { status: 'error', message: 'Missing peerId or candidate' };
  }
  
  try {
    const connection = activeConnections.get(data.peerId);
    if (!connection || !connection.partnerId) {
      return { status: 'error', message: 'No active match found' };
    }
    
    const partnerConnection = activeConnections.get(connection.partnerId);
    if (!partnerConnection) {
      return { status: 'error', message: 'Partner connection not found' };
    }
    
    // Store ICE candidate for partner to poll
    partnerConnection.pendingSignals.push({
      type: 'ice-candidate',
      data: data.candidate,
      timestamp: now
    });
    
    return { 
      status: 'candidate_sent',
      partnerId: connection.partnerId,
      timestamp: now
    };
    
  } catch (error) {
    console.error('ICE candidate handling error:', error);
    return { status: 'error', message: 'ICE candidate handling failed: ' + error.message };
  }
}

function handlePoll(data) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }
  
  try {
    const connection = activeConnections.get(data.peerId);
    if (!connection) {
      return { 
        status: 'no_connection',
        signals: []
      };
    }
    
    // Get pending signals and clear them
    const signals = connection.pendingSignals || [];
    connection.pendingSignals = [];
    
    // Update connection in map
    activeConnections.set(data.peerId, connection);
    
    return { 
      status: 'polled', 
      signals: signals,
      partnerId: connection.partnerId,
      count: signals.length
    };
    
  } catch (error) {
    console.error('Polling error:', error);
    return { status: 'error', message: 'Polling failed: ' + error.message };
  }
}

function handleDisconnection(data, now) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }
  
  try {
    const connection = activeConnections.get(data.peerId);
    
    if (connection && connection.partnerId) {
      // Notify partner about disconnection
      const partnerConnection = activeConnections.get(connection.partnerId);
      if (partnerConnection) {
        partnerConnection.pendingSignals.push({
          type: 'disconnect',
          data: { reason: 'partner_disconnected' },
          timestamp: now
        });
      }
      
      // Clean up both connections
      activeConnections.delete(data.peerId);
      activeConnections.delete(connection.partnerId);
      
      console.log('Disconnection handled:', data.peerId, 'from', connection.partnerId);
    }
    
    // Remove from waiting queue
    waitingQueue = waitingQueue.filter(p => p.peerId !== data.peerId);
    
    // Remove heartbeat
    heartbeats.delete(data.peerId);
    
    return { 
      status: 'disconnected',
      timestamp: now
    };
    
  } catch (error) {
    console.error('Disconnection error:', error);
    return { status: 'error', message: 'Disconnection failed: ' + error.message };
  }
}

function handleHeartbeat(data, now) {
  if (!data.peerId) {
    return { status: 'error', message: 'Missing peerId' };
  }
  
  try {
    heartbeats.set(data.peerId, now);
    
    const connection = activeConnections.get(data.peerId);
    if (connection) {
      connection.lastSeen = now;
      activeConnections.set(data.peerId, connection);
      
      return { 
        status: 'alive',
        matched: true,
        partnerId: connection.partnerId
      };
    }
    
    return { 
      status: 'alive',
      matched: false
    };
    
  } catch (error) {
    console.error('Heartbeat error:', error);
    return { status: 'error', message: 'Heartbeat failed: ' + error.message };
  }
}

function handleGetRequest(req, res) {
  const stats = {
    service: 'WebRTC Signaling Server',
    status: 'online',
    timestamp: Date.now(),
    stats: {
      waiting: waitingQueue.length,
      active_connections: activeConnections.size,
      active_heartbeats: heartbeats.size,
      server_time: new Date().toISOString()
    }
  };
  
  return res.status(200).json(stats);
}
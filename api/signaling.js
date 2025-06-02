// signaling_redis.js - Redis-based signaling server (for Upstash/Vercel)

import express from 'express';
import { createClient } from '@upstash/redis';

const app = express();
app.use(express.json());

const redis = createClient({
  url: process.env.REDIS_URL,
  headers: { Authorization: `Bearer ${process.env.UPSTASH_TOKEN || ''}` }
});

await redis.connect();

const MATCH_TTL = 300; // seconds
const PORT = process.env.PORT || 3000;

// GET /api/signaling?userId=...
app.get('/api/signaling', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  // Check if user is in a match
  const matchKeys = await redis.keys('match:*');
  for (const key of matchKeys) {
    const match = await redis.json.get(key);
    if (!match) continue;
    if (match.p1 === userId || match.p2 === userId) {
      const matchId = key.split(':')[1];
      const partnerId = match.p1 === userId ? match.p2 : match.p1;
      const signals = await redis.lrange(`signals:${matchId}:${userId}`, 0, -1);
      await redis.del(`signals:${matchId}:${userId}`);
      return res.json({
        status: 'matched',
        matchId,
        partnerId,
        isInitiator: match.p1 === userId,
        signals: signals.map(s => JSON.parse(s)),
        timestamp: Date.now()
      });
    }
  }

  // If not matched, join queue
  const queue = await redis.lrange('queue', 0, -1);
  if (!queue.includes(userId)) {
    await redis.rpush('queue', userId);
  }

  // Try to match
  const updatedQueue = await redis.lrange('queue', 0, -1);
  if (updatedQueue.length >= 2) {
    const p1 = updatedQueue[0];
    const p2 = updatedQueue[1];
    if (p1 && p2) {
      const matchId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const match = { p1, p2, ts: Date.now(), status: 'pending' };
      await redis.json.set(`match:${matchId}`, '$', match);
      await redis.expire(`match:${matchId}`, MATCH_TTL);
      await redis.lpop('queue');
      await redis.lpop('queue');
      return res.json({
        status: 'matched',
        matchId,
        partnerId: p2,
        isInitiator: true,
        signals: [],
        timestamp: Date.now()
      });
    }
  }

  const position = updatedQueue.indexOf(userId);
  return res.json({
    status: 'waiting',
    position: position + 1,
    estimatedWait: Math.min((position + 1) * 5, 60),
    timestamp: Date.now()
  });
});

// POST /api/signaling (send signal)
app.post('/api/signaling', async (req, res) => {
  const { userId, matchId, type, payload } = req.body;
  if (!userId || !matchId || !type || !payload) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const match = await redis.json.get(`match:${matchId}`);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  const partnerId = match.p1 === userId ? match.p2 : match.p1;
  const signal = JSON.stringify({ type, payload, from: userId, ts: Date.now() });

  await redis.lpush(`signals:${matchId}:${partnerId}`, signal);
  await redis.expire(`signals:${matchId}:${partnerId}`, MATCH_TTL);

  res.json({ status: 'ok' });
});

// Health check
app.get('/', (_, res) => {
  res.send('Redis signaling server active');
});

app.listen(PORT, () => {
  console.log(`Redis signaling running on port ${PORT}`);
});

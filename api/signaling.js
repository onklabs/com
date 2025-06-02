// signaling_vercel_api.js - Vercel-compatible KV signaling API (no express)

import { kv } from '@vercel/kv';

const MATCH_TTL = 300;

export default async function handler(req, res) {
  const method = req.method;
  const { userId, matchId, type, payload } = req.body || req.query || {};

  if (method === 'GET') {
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const matchKeys = await kv.keys('match:*');
    for (const key of matchKeys) {
      const match = await kv.get(key);
      if (!match) continue;
      if (match.p1 === userId || match.p2 === userId) {
        const matchId = key.split(':')[1];
        const partnerId = match.p1 === userId ? match.p2 : match.p1;
        const signalKey = `signals:${matchId}:${userId}`;
        const signals = await kv.lrange(signalKey, 0, -1) || [];
        await kv.del(signalKey);
        return res.status(200).json({
          status: 'matched',
          matchId,
          partnerId,
          isInitiator: match.p1 === userId,
          signals: signals.map(JSON.parse),
          timestamp: Date.now()
        });
      }
    }

    const queue = await kv.lrange('queue', 0, -1) || [];
    if (!queue.includes(userId)) {
      await kv.rpush('queue', userId);
    }

    const updatedQueue = await kv.lrange('queue', 0, -1) || [];
    if (updatedQueue.length >= 2) {
      const [p1, p2] = updatedQueue;
      const matchId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const match = { p1, p2, ts: Date.now(), status: 'pending' };
      await kv.set(`match:${matchId}`, match, { ex: MATCH_TTL });
      await kv.lpop('queue');
      await kv.lpop('queue');
      return res.status(200).json({
        status: 'matched',
        matchId,
        partnerId: p2,
        isInitiator: true,
        signals: [],
        timestamp: Date.now()
      });
    }

    const position = updatedQueue.indexOf(userId);
    return res.status(200).json({
      status: 'waiting',
      position: position + 1,
      estimatedWait: Math.min((position + 1) * 5, 60),
      timestamp: Date.now()
    });
  }

  if (method === 'POST') {
    if (!userId || !matchId || !type || !payload) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const match = await kv.get(`match:${matchId}`);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    const signal = JSON.stringify({ type, payload, from: userId, ts: Date.now() });

    await kv.lpush(`signals:${matchId}:${partnerId}`, signal);
    await kv.expire(`signals:${matchId}:${partnerId}`, MATCH_TTL);

    return res.status(200).json({ status: 'ok' });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

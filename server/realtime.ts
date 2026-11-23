import type { Request, Response } from 'express';

export type ClinicEventType =
  | 'connected'
  | 'queue:updated'
  | 'visit:updated'
  | 'payment:confirmed'
  | 'vitals:recorded'
  | 'lab:updated'
  | 'imaging:updated'
  | 'pharmacy:updated'
  | 'notification:created';

interface SseClient {
  id: number;
  userId: number;
  roles: string[];
  res: Response;
}

let nextClientId = 1;
const clients = new Map<number, SseClient>();

export function registerRealtimeClient(
  req: Request,
  res: Response,
  user: { id: number; roles: string[] }
): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const clientId = nextClientId++;
  clients.set(clientId, { id: clientId, userId: user.id, roles: user.roles, res });

  const initialPayload = JSON.stringify({
    type: 'connected',
    clientId,
    timestamp: new Date().toISOString(),
  });
  res.write(`event: connected\ndata: ${initialPayload}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
      clients.delete(clientId);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(clientId);
  });
}

export function broadcastClinicEvent(
  eventType: Exclude<ClinicEventType, 'connected'>,
  payload: Record<string, unknown> = {}
): void {
  const envelope = JSON.stringify({
    type: eventType,
    timestamp: new Date().toISOString(),
    ...payload,
  });
  const frame = `event: ${eventType}\ndata: ${envelope}\n\n`;

  for (const [id, client] of clients.entries()) {
    try {
      client.res.write(frame);
    } catch {
      clients.delete(id);
    }
  }
}

export function getRealtimeClientCount(): number {
  return clients.size;
}

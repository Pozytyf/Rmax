import type { Server as HttpServer } from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { parseCookieHeader, resolveAuthContextWithKnex } from './auth.ts';
import { getKnex } from './knex.ts';

interface ClientMeta {
  ws: WebSocket;
  room: string;
}

export interface ClusterEnvelope {
  originInstanceId: string;
  room: string;
  event: string;
  payload: unknown;
  timestamp: string;
}

export type ExternalPubSubPublisher = (envelope: ClusterEnvelope) => Promise<void> | void;

export const INSTANCE_ID =
  process.env.INSTANCE_ID?.trim() ||
  `node-${crypto.randomBytes(4).toString('hex')}`;

const clients = new Set<ClientMeta>();
let externalPublisher: ExternalPubSubPublisher | null = null;

export function registerClusterPublisher(fn: ExternalPubSubPublisher | null): void {
  externalPublisher = fn;
}

export function getWebSocketStats() {
  return {
    instanceId: INSTANCE_ID,
    connectedClients: clients.size,
    pubsubMode: externalPublisher ? 'CLUSTER_PUBSUB' : 'SINGLE_NODE',
  };
}

export function deliverLocalRoomEvent(
  room: string,
  event: string,
  payload: unknown,
  timestamp = new Date().toISOString(),
): void {
  const message = JSON.stringify({
    type: event,
    payload,
    timestamp,
    instanceId: INSTANCE_ID,
  });
  for (const client of clients) {
    if (client.room === room && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

export function handleIncomingClusterEnvelope(envelope: ClusterEnvelope): void {
  if (envelope.originInstanceId === INSTANCE_ID) return;
  deliverLocalRoomEvent(
    envelope.room,
    envelope.event,
    envelope.payload,
    envelope.timestamp,
  );
}

async function authorizeWebSocketRoom(
  room: string,
  token: string | null,
): Promise<boolean> {
  if (!token) return false;

  const auth = await resolveAuthContextWithKnex(token);
  if (!auth) return false;

  if (room === 'superadmin') return auth.role === 'SUPER_ADMIN';

  if (room.startsWith('restaurant:')) {
    const targetRid = room.slice('restaurant:'.length);
    return Boolean(targetRid) && (auth.role === 'SUPER_ADMIN' || auth.restaurantId === targetRid);
  }

  const orderMatch = /^order:([a-zA-Z0-9_-]+)$/.exec(room);
  if (orderMatch) {
    if (auth.role === 'SUPER_ADMIN') return true;
    if (!auth.restaurantId) return false;
    const order = await getKnex()('orders')
      .select('restaurant_id')
      .where({ id: orderMatch[1] })
      .first();
    return Boolean(order && order.restaurant_id === auth.restaurantId);
  }

  return false;
}

export function setupWebSocketServer(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      return;
    }
    if (pathname !== '/ws') {
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/ws', 'http://localhost');
    const room = url.searchParams.get('room') || '';
    const authHeader = req.headers.authorization;
    const bearer =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : null;
    const cookies = parseCookieHeader(req.headers.cookie);
    const token =
      bearer || cookies.restomax_token || url.searchParams.get('token') || null;

    void authorizeWebSocketRoom(room, token)
      .then((allowed) => {
        if (!allowed || ws.readyState !== WebSocket.OPEN) {
          ws.close(1008, 'Accès WebSocket non autorisé.');
          return;
        }

        const meta: ClientMeta = { ws, room };
        clients.add(meta);
        ws.send(
          JSON.stringify({
            type: 'connection:ready',
            room,
            instanceId: INSTANCE_ID,
            timestamp: new Date().toISOString(),
          }),
        );
        ws.on('close', () => clients.delete(meta));
        ws.on('error', () => clients.delete(meta));
      })
      .catch(() => {
        ws.close(1011, 'Impossible de vérifier les autorisations WebSocket.');
      });
  });;
}

export function broadcastToRoom(
  room: string,
  event: string,
  payload: unknown,
): void {
  const timestamp = new Date().toISOString();
  deliverLocalRoomEvent(room, event, payload, timestamp);

  if (externalPublisher) {
    Promise.resolve(
      externalPublisher({
        originInstanceId: INSTANCE_ID,
        room,
        event,
        payload,
        timestamp,
      }),
    ).catch(() => {
      // Non-blocking cluster relay
    });
  }
}

export function broadcastRestaurantEvent(
  restaurantId: string,
  event: string,
  payload: unknown,
): void {
  broadcastToRoom(`restaurant:${restaurantId}`, event, payload);
}

export function broadcastOrderTrackerEvent(
  orderId: string,
  event: string,
  payload: unknown,
): void {
  broadcastToRoom(`order:${orderId}`, event, payload);
}

export function broadcastSuperAdminEvent(
  event: string,
  payload: unknown,
): void {
  broadcastToRoom('superadmin', event, payload);
}

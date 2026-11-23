import { useEffect, useRef, useState } from 'react';
import { getAuthToken } from './api';

export type ClinicEventType =
  | 'connected'
  | 'visit:updated'
  | 'queue:updated'
  | 'payment:confirmed'
  | 'vitals:recorded'
  | 'lab:updated'
  | 'imaging:updated'
  | 'pharmacy:updated'
  | 'notification:created';

export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

type EventHandler = (payload: Record<string, unknown>, eventType: ClinicEventType) => void;

const listenersByEvent = new Map<ClinicEventType, Set<EventHandler>>();
const statusListeners = new Set<(status: RealtimeStatus) => void>();

let source: EventSource | null = null;
let currentToken: string | null = null;
let currentStatus: RealtimeStatus = 'disconnected';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(next: RealtimeStatus) {
  currentStatus = next;
  for (const listener of statusListeners) {
    listener(next);
  }
}

const STREAM_EVENTS: ClinicEventType[] = [
  'connected',
  'visit:updated',
  'queue:updated',
  'payment:confirmed',
  'vitals:recorded',
  'lab:updated',
  'imaging:updated',
  'pharmacy:updated',
  'notification:created',
];

function closeStream() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (source) {
    source.close();
    source = null;
  }
  currentToken = null;
  setStatus('disconnected');
}

function ensureStream() {
  const token = getAuthToken();
  if (!token) {
    closeStream();
    return;
  }
  if (source && currentToken === token) {
    return;
  }
  closeStream();
  currentToken = token;
  setStatus('connecting');

  const es = new EventSource(`/api/events/stream?token=${encodeURIComponent(token)}`);
  source = es;

  es.onopen = () => {
    setStatus('connected');
  };

  for (const eventName of STREAM_EVENTS) {
    es.addEventListener(eventName, (ev) => {
      if (eventName === 'connected') {
        setStatus('connected');
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = ev.data ? (JSON.parse(ev.data) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      const handlers = listenersByEvent.get(eventName);
      if (handlers) {
        for (const fn of handlers) {
          fn(parsed, eventName);
        }
      }
    });
  }

  es.onerror = () => {
    es.close();
    if (source === es) {
      source = null;
    }
    if (!getAuthToken()) {
      setStatus('disconnected');
      return;
    }
    setStatus('reconnecting');
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        ensureStream();
      }, 2500);
    }
  };
}

export function resetRealtimeStream() {
  closeStream();
  if (getAuthToken()) {
    ensureStream();
  }
}

export function useRealtimeSync(events: ClinicEventType[], handler: EventHandler, enabled = true) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const eventsKey = events.join(',');

  useEffect(() => {
    if (!enabled) return;
    ensureStream();

    const wrapped: EventHandler = (payload, type) => {
      handlerRef.current(payload, type);
    };

    const list = eventsKey.split(',').filter(Boolean) as ClinicEventType[];
    for (const ev of list) {
      if (!listenersByEvent.has(ev)) {
        listenersByEvent.set(ev, new Set());
      }
      listenersByEvent.get(ev)!.add(wrapped);
    }

    return () => {
      for (const ev of list) {
        listenersByEvent.get(ev)?.delete(wrapped);
      }
    };
  }, [eventsKey, enabled]);
}

export function useRealtimeStatus(enabled = true): RealtimeStatus {
  const [status, setLocalStatus] = useState<RealtimeStatus>(currentStatus);

  useEffect(() => {
    if (!enabled) {
      setLocalStatus('disconnected');
      return;
    }
    ensureStream();
    setLocalStatus(currentStatus);
    const onChange = (next: RealtimeStatus) => setLocalStatus(next);
    statusListeners.add(onChange);
    return () => {
      statusListeners.delete(onChange);
    };
  }, [enabled]);

  return status;
}

import { randomUUID } from 'node:crypto';
import type { DirectionsRoute } from './directions.js';

export const directionsLifetimeSeconds = 15 * 60;
export type DirectionsHandoff = DirectionsRoute & { id: string; createdAt: number; expiresAt: number };

export function makeDirectionsHandoff(route: DirectionsRoute): DirectionsHandoff {
  const createdAt = Date.now();
  return { ...route, id: randomUUID(), createdAt, expiresAt: createdAt + directionsLifetimeSeconds * 1000 };
}

export function activeDirections(value: unknown): DirectionsHandoff | null {
  if (typeof value !== 'object' || value === null) return null;
  const route = value as Partial<DirectionsHandoff>;
  return typeof route.id === 'string' && typeof route.expiresAt === 'number' && route.expiresAt > Date.now()
    ? route as DirectionsHandoff : null;
}

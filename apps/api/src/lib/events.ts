import { PRODUCT_EVENTS, sanitizeEventProps, type EventProps, type ProductEventName } from '@linguaflow/shared';
import { db } from '../db/index.js';
import { productEvents } from '../db/schema.js';

export async function recordEvent(input: { userId?: string | null; name: string; dedupeKey: string; source?: 'server' | 'client'; props?: EventProps }) {
  if (!(PRODUCT_EVENTS as readonly string[]).includes(input.name)) return;
  try {
    await db.insert(productEvents).values({
      userId: input.userId ?? null,
      name: input.name as ProductEventName,
      dedupeKey: input.dedupeKey.slice(0, 180),
      source: input.source ?? 'server',
      props: sanitizeEventProps(input.props)
    }).onConflictDoNothing({ target: productEvents.dedupeKey });
  } catch (error) {
    console.warn('[LinguaFlow] event dropped', input.name, error instanceof Error ? error.message : 'unknown');
  }
}

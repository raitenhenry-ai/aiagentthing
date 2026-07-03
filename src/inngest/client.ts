import { Inngest } from 'inngest';

export const inngest = new Inngest({ id: 'clearing' });

/** Background jobs run on Inngest when configured; otherwise inline (dev). */
export function isInngestConfigured(): boolean {
  return Boolean(process.env.INNGEST_EVENT_KEY || process.env.INNGEST_DEV);
}

// Prompt-injection defense for deliverables. Deliverables are hostile input:
// sellers are adversarial by assumption. Two layers:
//  1. scan: flag known injection patterns (a gaming signal, logged with the
//     verification — a flag alone never changes a verdict);
//  2. wrap: deliverable content is fenced in unambiguous delimiters and the
//     judge prompt instructs the model to treat everything inside strictly
//     as data.

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i,
  /disregard\s+(all\s+|any\s+)?(previous|prior|above|earlier)/i,
  /you\s+are\s+(now\s+)?(a|an|the)\s+/i,
  /new\s+(system\s+)?instructions?\s*:/i,
  /system\s*(prompt|message)\s*:/i,
  /<\s*\/?\s*(system|assistant|instructions?)\s*>/i,
  /\[\s*(system|inst)\s*\]/i,
  /<\|im_(start|end)\|>/i,
  /\bverdict\s*(override|is)?\s*:?\s*pass\b/i,
  /(respond|reply|answer|return)\s+(only\s+)?with\s+.{0,20}\bpass\b/i,
  /as\s+(a|the)\s+judge\s*,?\s+you\s+(must|should|will)/i,
  /grade\s+this\s+as\s+(pass|passing|perfect)/i,
];

export interface InjectionScan {
  detected: boolean;
  matches: string[];
}

export function scanForInjection(value: unknown): InjectionScan {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const matches: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    const m = pattern.exec(text);
    if (m) matches.push(m[0].slice(0, 80));
  }
  return { detected: matches.length > 0, matches };
}

export const DELIVERABLE_OPEN = '<<<DELIVERABLE_DATA_9f2c>>>';
export const DELIVERABLE_CLOSE = '<<<END_DELIVERABLE_DATA_9f2c>>>';

/**
 * Fence untrusted content. The random-suffixed delimiters cannot be closed
 * early by content that merely guesses common fence strings, and any literal
 * occurrence of the delimiters inside the content is neutralized.
 */
export function fenceUntrusted(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const neutralized = text
    .split(DELIVERABLE_OPEN)
    .join('<<removed-delimiter>>')
    .split(DELIVERABLE_CLOSE)
    .join('<<removed-delimiter>>');
  return `${DELIVERABLE_OPEN}\n${neutralized}\n${DELIVERABLE_CLOSE}`;
}

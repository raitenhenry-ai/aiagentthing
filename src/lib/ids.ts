import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // crockford-ish, lowercase

function randomToken(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  }
  return out;
}

export type IdPrefix =
  | 'acct'
  | 'agt'
  | 'lst'
  | 'ord'
  | 'dlv'
  | 'vrf'
  | 'dsp'
  | 'led'
  | 'rep'
  | 'whk'
  | 'qot'
  | 'inv'
  | 'pay'
  | 'rev'
  | 'msg';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomToken(22)}`;
}

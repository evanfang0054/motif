import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** scrypt 口令散列：scrypt$<salt>$<hash> */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 32).toString('hex')
  return `scrypt$${salt}$${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const hash = scryptSync(password, parts[1], 32)
  const expected = Buffer.from(parts[2], 'hex')
  return hash.length === expected.length && timingSafeEqual(hash, expected)
}

export const SESSION_COOKIE = 'motif_session'
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Env } from '../../config/env.js';

/**
 * AES-256-GCM encryption for sensitive scalar fields (e.g. national ID).
 * Format: `v1.<iv>.<tag>.<ciphertext>` (base64url). The key is derived from
 * FIELD_ENCRYPTION_KEY; without a key (dev only) values are stored with a
 * clearly-marked plaintext prefix so nobody mistakes them for encrypted data.
 */
@Injectable()
export class FieldEncryptionService {
  private readonly logger = new Logger(FieldEncryptionService.name);
  private readonly key: Buffer | null;

  constructor(config: ConfigService<Env, true>) {
    const raw = config.get('fieldEncryptionKey', { infer: true });
    this.key = raw ? createHash('sha256').update(raw).digest() : null;
    if (!this.key) this.logger.warn('FIELD_ENCRYPTION_KEY not set - sensitive fields are NOT encrypted');
  }

  encrypt(plain: string | null | undefined): string | null {
    if (plain === null || plain === undefined || plain === '') return null;
    if (!this.key) return `plain.${plain}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
  }

  decrypt(stored: string | null | undefined): string | null {
    if (!stored) return null;
    if (stored.startsWith('plain.')) return stored.slice('plain.'.length);
    if (!this.key) return null;
    const [version, ivB64, tagB64, dataB64] = stored.split('.');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** Last 4 characters only, for display without revealing the identifier. */
  mask(stored: string | null | undefined): string | null {
    const plain = this.decrypt(stored);
    if (!plain) return null;
    return plain.length <= 4 ? '****' : `${'*'.repeat(plain.length - 4)}${plain.slice(-4)}`;
  }
}

import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;

export interface EncryptedPayload {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

export class DataEncryption {
  static deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
  }

  static encrypt(plaintext: Buffer, key: Buffer): EncryptedPayload {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { iv, authTag, ciphertext };
  }

  static decrypt(ciphertext: Buffer, iv: Buffer, authTag: Buffer, key: Buffer): Buffer {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext;
  }

  static encryptDatabase(dbPath: string, keyHex: string): void {
    const key = Buffer.from(keyHex, 'hex');
    const data = fs.readFileSync(dbPath);
    const encrypted = this.encrypt(data, key);
    const encPath = dbPath + '.enc';
    fs.writeFileSync(encPath, Buffer.concat([encrypted.iv, encrypted.authTag, encrypted.ciphertext]));
  }

  static decryptDatabase(encPath: string, keyHex: string): Buffer {
    const key = Buffer.from(keyHex, 'hex');
    const data = fs.readFileSync(encPath);
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    return this.decrypt(ciphertext, iv, authTag, key);
  }
}

export class SqliteCipher {
  private dbPath: string;
  private keyHex: string;
  private db: Database.Database | null = null;
  private tempPath: string = '';

  constructor(dbPath: string, keyHex: string) {
    this.dbPath = dbPath;
    this.keyHex = keyHex;
  }

  open(): void {
    if (this.db) return;
    const tempDir = process.env.TEMP || path.dirname(this.dbPath);
    this.tempPath = path.join(tempDir, `${path.basename(this.dbPath)}.${randomUUID()}.tmp`);
    const decrypted = DataEncryption.decryptDatabase(this.dbPath + '.enc', this.keyHex);
    fs.writeFileSync(this.tempPath, decrypted);
    this.db = new Database(this.tempPath);
  }

  getDb(): Database.Database {
    if (!this.db) this.open();
    return this.db!;
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    if (this.tempPath && fs.existsSync(this.tempPath)) {
      try {
        const data = fs.readFileSync(this.tempPath);
        const encrypted = DataEncryption.encrypt(data, Buffer.from(this.keyHex, 'hex'));
        fs.writeFileSync(this.dbPath + '.enc', Buffer.concat([encrypted.iv, encrypted.authTag, encrypted.ciphertext]));
        fs.unlinkSync(this.tempPath);
      } catch {
        // ignore cleanup errors
      }
    }
    this.tempPath = '';
  }
}

/**
 * Typed, validated environment configuration. Fails fast at boot when a required
 * variable is missing so misconfiguration never reaches production traffic.
 */
export interface Env {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  jwtRefreshExpiresIn: string;
  corsOrigin: string[];
  fieldEncryptionKey: string;
  ai: {
    provider: 'claude' | 'gemini' | 'none';
    anthropicApiKey?: string;
    claudeModel: string;
    geminiApiKey?: string;
    geminiModel: string;
  };
  /** Semantic record search (pgvector). `none` disables embeddings; search still works via trigram/full-text. */
  embedding: {
    provider: 'gemini' | 'none';
    model: string;
    geminiApiKey?: string;
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function loadEnv(): Env {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as Env['nodeEnv'];
  const jwtSecret = required('JWT_SECRET');
  if (nodeEnv === 'production' && jwtSecret === 'change-me-in-production') {
    throw new Error('JWT_SECRET must be changed in production');
  }
  const fieldEncryptionKey = process.env.FIELD_ENCRYPTION_KEY ?? '';
  if (nodeEnv === 'production' && !fieldEncryptionKey) {
    throw new Error('FIELD_ENCRYPTION_KEY is required in production');
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || undefined;
  const geminiApiKey = process.env.GEMINI_API_KEY || undefined;
  const requested = (process.env.AI_PROVIDER ?? 'claude') as 'claude' | 'gemini';
  const provider: Env['ai']['provider'] =
    requested === 'gemini' ? (geminiApiKey ? 'gemini' : 'none') : anthropicApiKey ? 'claude' : 'none';
  const embeddingRequested = (process.env.EMBEDDING_PROVIDER ?? 'gemini') as 'gemini' | 'none';
  const embeddingProvider: Env['embedding']['provider'] = embeddingRequested === 'gemini' && geminiApiKey ? 'gemini' : 'none';

  return {
    nodeEnv,
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: required('DATABASE_URL'),
    jwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
    jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
    corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:4200').split(',').map((s) => s.trim()),
    fieldEncryptionKey,
    ai: {
      provider,
      anthropicApiKey,
      claudeModel: process.env.CLAUDE_MODEL ?? 'claude-opus-5-5',
      geminiApiKey,
      geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-pro',
    },
    embedding: {
      provider: embeddingProvider,
      model: process.env.EMBEDDING_MODEL ?? 'gemini-embedding-001',
      geminiApiKey,
    },
  };
}

import path from 'node:path';
import 'dotenv/config';

const required = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

const production = process.env.NODE_ENV === 'production';
export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.API_PORT ?? 3000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  databaseUrl: required('DATABASE_URL', 'postgres://linguaflow:linguaflow@localhost:5432/linguaflow'),
  jwtSecret: required('JWT_SECRET', production ? undefined : 'development-secret-change-me'),
  sonioxApiKey: required('SONIOX_API_KEY', production ? undefined : 'development-only'),
  sonioxWsUrl: process.env.SONIOX_WS_URL ?? 'wss://stt-rt.soniox.com/transcribe-websocket',
  adminEmail: required('ADMIN_EMAIL', production ? undefined : 'admin@example.com').toLowerCase(),
  bootstrapEmail: process.env.BOOTSTRAP_EMAIL?.toLowerCase(),
  bootstrapPassword: process.env.BOOTSTRAP_PASSWORD,
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    from: process.env.SMTP_FROM ?? 'LinguaFlow <no-reply@linguaflow.local>'
  },
  recordingsDir: path.resolve(process.env.RECORDINGS_DIR ?? 'data/recordings'),
  pdfFontPath: process.env.PDF_FONT_PATH ?? '',
  settingsEncryptionKey: process.env.SETTINGS_ENCRYPTION_KEY,
  platformSummary: {
    apiBase: process.env.PLATFORM_SUMMARY_API_BASE ?? '',
    apiKey: process.env.PLATFORM_SUMMARY_API_KEY ?? '',
    model: process.env.PLATFORM_SUMMARY_MODEL ?? ''
  }
};

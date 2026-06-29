// TEST FIXTURE (secret-leak / good) — contains NO secrets.
// Config reads from the environment; nothing sensitive is hardcoded here.
export const config = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_ANON_KEY,
  resendKey: process.env.RESEND_API_KEY,
  region: "us-east-1",
  featureFlags: { commerce: true, seoCapture: false },
};

import { z } from "zod";

/** Server-only Yappy settings. Never import this from client components. */
const schema = z.object({
  YAPPY_MERCHANT_ID: z.string().min(1),
  YAPPY_SECRET_KEY: z.string().min(1),
  YAPPY_DOMAIN: z.string().url(),
  YAPPY_BASE_URL: z.string().url(),
  /** Public base URL of this app, used to build the IPN URL sent to Yappy. */
  APP_BASE_URL: z.string().url(),
});

export type YappyConfig = {
  merchantId: string;
  secretKey: string;
  domain: string;
  baseUrl: string;
  ipnUrl: string;
};

export function isYappyMock(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YAPPY_MODE === "mock";
}

export function readYappyConfig(env: NodeJS.ProcessEnv = process.env): YappyConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Only the variable names, never their values.
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Yappy is not configured: check ${missing}`);
  }
  const e = parsed.data;
  return {
    merchantId: e.YAPPY_MERCHANT_ID,
    secretKey: e.YAPPY_SECRET_KEY,
    domain: e.YAPPY_DOMAIN,
    baseUrl: e.YAPPY_BASE_URL.replace(/\/+$/, ""),
    ipnUrl: `${e.APP_BASE_URL.replace(/\/+$/, "")}/api/yappy/ipn`,
  };
}

import pino from "pino";
import { env, isProduction } from "./config/env.js";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : isProduction ? "info" : "debug",
  transport: isProduction
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
      },
  redact: {
    paths: [
      "accessToken",
      "refreshToken",
      "access_token",
      "refresh_token",
      "*.accessToken",
      "*.refreshToken",
      "req.headers.authorization",
    ],
    censor: "[redacted]",
  },
});

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

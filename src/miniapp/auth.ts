import type { NextFunction, Request, Response } from "express";
import { isProduction } from "../config/env.js";
import { isApprover } from "../telegram/bot.js";
import { verifyInitData } from "./initData.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Set by requireApprover once the caller's Telegram identity is confirmed. */
    telegramUserId?: string;
  }
}

/**
 * Every Mini App route is locked to the single approver, the same as every Telegram
 * command. The caller proves who they are with the `initData` Telegram hands the Mini
 * App, sent back as `Authorization: tma <initData>` (Telegram's documented scheme).
 */
export function requireApprover(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const initData = /^tma /i.test(header) ? header.slice(4) : "";

  if (!initData) {
    if (!isProduction) {
      // Local dev with no Telegram shell around the page: proceed as the approver so
      // `npm run dev` works from a plain browser tab. isProduction keeps this out of
      // any real deployment.
      req.telegramUserId = undefined;
      next();
      return;
    }
    res.status(401).json({ error: "Missing Telegram authorization" });
    return;
  }

  const user = verifyInitData(initData);
  if (!user || !isApprover(user.id)) {
    res.status(401).json({ error: "Not authorized" });
    return;
  }

  req.telegramUserId = String(user.id);
  next();
}

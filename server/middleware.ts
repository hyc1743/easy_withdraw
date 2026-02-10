import type { Request, Response, NextFunction } from "express";
import type { SessionManager } from "./security.js";

// --------------- Session Guard ---------------

export function requireSession(session: SessionManager) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!session.isUnlocked) {
      res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED",
        message: "Session not unlocked",
      });
      return;
    }
    next();
  };
}

// --------------- Request Logger ---------------

export function requestLogger() {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      console.log(
        `${req.method} ${req.path} ${res.statusCode} ${ms}ms`,
      );
    });
    next();
  };
}

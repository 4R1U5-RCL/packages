// GOOD fixture: a login handler that wires a recognized security-logging sink.
import { logSecurityEvent } from "../lib/security-log";

export async function login(req: { email: string; password: string }, ip: string) {
  const user = await authenticate(req.email, req.password);
  if (!user) {
    logSecurityEvent({
      type: "auth.login.failed",
      email: req.email,
      ip,
      at: new Date().toISOString(),
    });
    throw new Error("invalid credentials");
  }
  logSecurityEvent({ type: "auth.login.success", userId: user.id, ip });
  return user;
}

async function authenticate(_email: string, _password: string) {
  return null as null | { id: string };
}

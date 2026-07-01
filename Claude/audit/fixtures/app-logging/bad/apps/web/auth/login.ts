// BAD fixture: the same login handler with NO security-logging call wired in.
export async function login(req: { email: string; password: string }) {
  const user = await authenticate(req.email, req.password);
  if (!user) {
    throw new Error("invalid credentials");
  }
  return user;
}

async function authenticate(_email: string, _password: string) {
  return null as null | { id: string };
}

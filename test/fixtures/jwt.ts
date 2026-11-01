const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

// Builds an unsigned JWT, enough for code that only reads its claims.
export function makeJwt(claims: Record<string, unknown>): string {
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

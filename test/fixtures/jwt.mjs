// Builds an unsigned JWT, enough for code that only reads its claims.
export function makeJwt(claims) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

/**
 * The message a promise rejects with. Fails when it resolves, so a test
 * reads `expect(await rejectionMessage(p)).toMatch(...)`.
 */
export async function rejectionMessage(
  promise: Promise<unknown>,
): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Expected the promise to reject, and it resolved.");
}

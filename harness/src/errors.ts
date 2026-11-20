export class RpcError extends Error {
  constructor(
    public code: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST",
    options?: { message: string },
  ) {
    super(options?.message ?? code);
  }
}

export class MobileError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

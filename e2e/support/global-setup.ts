import { startStack, stopStack } from "./stack.ts";

/** Starts the services once; tests read what started from WEFT_E2E_INFO. */
export default async function globalSetup() {
  const info = await startStack();
  process.env.WEFT_E2E_INFO = JSON.stringify(info);
  return async () => stopStack();
}

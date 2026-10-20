import type { createOpencodeClient } from '@opencode-ai/sdk/client';
import type { OpenCodeServerConnection } from '../../protocols/OpenCodeSDKProtocol';
import { createOpenCodeV2Client } from './v2/OpenCodeV2Client';

export interface OpenCodeSdkClientModule {
  createOpencodeClient: typeof createOpencodeClient;
}

/**
 * Client for whichever API the running server speaks: the 2.x HTTP client
 * when the server manager detected OpenCode 2.x, the 1.x SDK otherwise. Both
 * return 1.x-shaped results, so catalog readers need no version branches.
 */
export async function createOpenCodeClientForServer(
  connection: OpenCodeServerConnection
): Promise<unknown> {
  if (connection.apiVersion === 2 && connection.authorization) {
    return createOpenCodeV2Client({
      baseUrl: connection.baseUrl,
      authorization: connection.authorization,
    });
  }
  const sdk = await loadOpenCodeSdkClientModule();
  return sdk.createOpencodeClient({ baseUrl: connection.baseUrl });
}

/** Load the ESM-only OpenCode client through the single packaged-app boundary. */
export async function loadOpenCodeSdkClientModule(): Promise<OpenCodeSdkClientModule> {
  try {
    const moduleName = '@opencode-ai/sdk/client';
    return (await import(
      /* webpackIgnore: true */ moduleName
    )) as OpenCodeSdkClientModule;
  } catch (error) {
    throw new Error(
      'Failed to load @opencode-ai/sdk. Install it with: npm install @opencode-ai/sdk\n' +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

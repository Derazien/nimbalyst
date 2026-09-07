// Properties a host process may add to Node's `process`, declared here so
// runtime can read them without depending on that host's types.
//
// `process.resourcesPath` is set by Electron and is absent under plain Node.
// Runtime used to get this declaration for free from `@types/electron`, pulled
// in by an `import { app } from 'electron'` that no longer exists. Typing it as
// possibly-undefined is also more honest than Electron's own `string`: every
// caller here already has to handle a headless host where there is no such
// directory, and `resolvePackagedCodexBinaryPath` does exactly that.

declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string;
    }
  }
}

export {};

/**
 * extensionHostUi - the host components an extension's host component may RENDER.
 *
 * WHY THIS EXISTS. Extensions can contribute host components (see ExtensionHostComponents), and
 * until now the traffic was one way: the app mounted an extension's component and handed it
 * nothing. An extension that wanted a chat surface therefore had to build a second one, against
 * the same providers, with its own transcript, its own composer and its own session plumbing. A
 * second chat beside the app's own is always the one that rots: it lags every improvement to the
 * real one and it drifts on the details nobody remembers to port.
 *
 * So the app passes the real thing down instead. An extension mounts the app's OWN ChatSidebar,
 * inside the app's own React tree, above which every provider it needs already sits. There is one
 * chat implementation and extensions borrow it.
 *
 * DELIBERATELY A SMALL, EXPLICIT TABLE rather than a general escape hatch. Everything named here
 * is a component the app is willing to have rendered somewhere it did not choose, which is a real
 * commitment about props and lifecycle. Adding a row is a decision; a generic
 * "give me any component by name" would make it an accident.
 *
 * The object identity is stable for the life of the module, so passing it as a prop never
 * re-renders anything by itself.
 */
import { ChatSidebar } from './ChatSidebar/ChatSidebar';

/**
 * What an extension host component receives. Optional on the extension's side by convention: an
 * extension built against an older app must still mount, and must degrade rather than crash.
 */
export interface ExtensionHostUi {
  ChatSidebar: typeof ChatSidebar;
}

export const EXTENSION_HOST_UI: ExtensionHostUi = Object.freeze({ ChatSidebar });

/** The props every extension host component is mounted with. */
export interface ExtensionHostComponentProps {
  hostUi: ExtensionHostUi;
}

/**
 * ExtensionHostComponents - Renders host components from loaded extensions.
 *
 * Extensions can contribute host components that need to be rendered at the app level
 * (e.g., picker menus, floating dialogs). This component renders all such components
 * from enabled extensions.
 */

import type { JSX } from 'react';
import { useState, useEffect } from 'react';
import { getExtensionLoader } from '@nimbalyst/runtime';
import type { ComponentType } from 'react';
import { EXTENSION_HOST_UI, type ExtensionHostComponentProps } from './extensionHostUi';

interface HostComponentInfo {
  extensionId: string;
  componentName: string;
  component: ComponentType<Partial<ExtensionHostComponentProps>>;
}

export function ExtensionHostComponents(): JSX.Element {
  const [hostComponents, setHostComponents] = useState<HostComponentInfo[]>([]);

  useEffect(() => {
    const loader = getExtensionLoader();

    // Function to sync host components from loaded extensions
    function syncHostComponents() {
      const components = loader.getHostComponents();
      setHostComponents(components);
    }

    // Initial sync
    syncHostComponents();

    // Subscribe to extension changes
    const unsubscribe = loader.subscribe(syncHostComponents);

    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <>
      {hostComponents.map((info) => {
        const Component = info.component;
        // The app's own components an extension may render, chiefly ChatSidebar, so an extension
        // that wants a chat surface borrows the real one instead of growing a second. See
        // extensionHostUi.ts. Extensions treat the prop as optional, so one built against an
        // older app still mounts and simply has nothing to borrow.
        return (
          <Component key={`${info.extensionId}-${info.componentName}`} hostUi={EXTENSION_HOST_UI} />
        );
      })}
    </>
  );
}

export default ExtensionHostComponents;

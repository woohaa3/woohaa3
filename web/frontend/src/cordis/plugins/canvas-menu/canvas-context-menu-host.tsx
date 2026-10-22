import { useSyncExternalStore } from "react";
import { useService } from "../../react.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { useContextMenuItems, useSelectContextMenuItem } from "../../host.js";
import type { ContextMenuContext } from "../../contracts.js";
import type { CanvasMenuRoute } from "../../navigation/contracts.js";
import { CanvasContextMenu } from "./canvas-context-menu.js";

import CanvasCreationPopover from "./canvas-creation-popover.js";

export default function ContextMenuHost({
  menu,
  writable
}: {
  menu: CanvasMenuRoute;
  writable: boolean;
}) {
  const canvasNavigation = useService("canvasNavigation");
  const selection = useSyncExternalStore(
    nodeSelectionStore.subscribe,
    nodeSelectionStore.getSnapshot,
    nodeSelectionStore.getSnapshot
  );
  const context: ContextMenuContext = {
    nodeId: menu.nodeId,
    screen: menu.screen,
    world: menu.world,
    ...(menu.connectFrom ? { connectFrom: menu.connectFrom } : {}),
    writable,
    selectedNodeIds: selection.nodeIds
  };
  const items = useContextMenuItems(context);
  const select = useSelectContextMenuItem();
  const close = () => { if (canvasNavigation.getSnapshot().menu === menu) canvasNavigation.closeMenu(); };
  const selectItem = (itemId: string) => { select(itemId, context); canvasNavigation.closeMenu(); };
  const blank = !menu.nodeId && !menu.connectFrom;
  const basicMenu = (
    <CanvasContextMenu
      x={menu.screen.x}
      y={menu.screen.y}
      items={items}
      label={menu.nodeId ? "节点操作" : "节点"}
      onSelect={selectItem}
      onClose={close}
    />
  );
  return blank ? <CanvasCreationPopover
    key={`${menu.screen.x}:${menu.screen.y}:${menu.world.x}:${menu.world.y}`}
    menuIdentity={menu} screen={menu.screen} world={menu.world} items={items} writable={writable}
    onSelect={selectItem} onClose={close}
  /> : basicMenu;
}

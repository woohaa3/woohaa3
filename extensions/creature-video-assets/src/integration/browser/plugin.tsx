import "../../authoring/browser/styles.css";
import { createElement } from "react";
import { CANVAS_MENU_SECTION } from "@woohaa3/contracts";
import { defineExtensionFrontend, defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import { CREATURE_FRONTEND_METADATA } from "../shared/metadata.js";
import { EXTENSION_ID } from "../../state/shared/recipe.js";
import { cardOwner } from "../../preview/shared/projection.js";
import { WorkflowController } from "./controller.js";
import { WorkflowOverlay } from "../../authoring/browser/panel.js";
import type { WorkflowContext } from "./context.js";
export function creatureVideoAssetsExtension() {
  return defineExtensionPlugin<WorkflowContext>(ctx => {
    const disposers: (() => void)[] = [];
    const dispose = () => { for (const release of disposers.splice(0).reverse()) release(); };
    ctx.effect(() => dispose, "creature-workflow");
    try {
      const controller = new WorkflowController(ctx);
      disposers.push(() => controller.dispose());
      disposers.push(ctx.compositeAssets.register({ extensionId: EXTENSION_ID, owner: EXTENSION_ID, label: "生物资产制作", scopeShape: "rect", executionKey: data => JSON.stringify(data.extensionContentRef), prepare: () => ({}) }));
      disposers.push(ctx.slots.register("canvas.node-template", { id: "creature-workflow-node", owner: EXTENSION_ID, nodeType: "composite-asset", label: "生物资产制作", section: CANVAS_MENU_SECTION.creationTools, order: 2, createNodeData: () => ({ extensionId: EXTENSION_ID, extensionContentRef: { schemaVersion: 1, instanceId: crypto.randomUUID() }, title: "生物资产制作" }) }));
      disposers.push(ctx.slots.register("canvas.node-drop", { id: "creature-reference-drop", owner: EXTENSION_ID, nodeType: "composite-asset", dropLabel: "拖入作为参考图，原图回位", matchesTarget: ({ canvas, targetNodeId }) => cardOwner(canvas.nodeData[targetNodeId])?.role === "input", acceptsSources: ({ canvas, sourceNodeIds }) => sourceNodeIds.every(id => canvas.document.nodes.some(node => node.id === id && node.type === "image") && !cardOwner(canvas.nodeData[id])), onDrop: ({ canvas, targetNodeId, sourceNodeIds }) => controller.drop(canvas, targetNodeId, sourceNodeIds) }));
      disposers.push(ctx.slots.register("canvas.overlay", { id: "creature-workflow-overlay", owner: EXTENSION_ID, priority: 25, render: ({ writable, focus, modalActive }) => createElement(WorkflowOverlay, { controller, writable, hidden: !!focus || modalActive }) }));
      void ctx.taskCatalog.load();
    } catch (error) { dispose(); throw error; }
  }, { name: EXTENSION_ID, inject: ["slots", "compositeAssets", "canvasState", "canvasRuntime", "canvasCommands", "applicationRemote", "taskCatalog", "canvasNavigation", "mediaRemote", "selection"] });
}
export const descriptor = defineExtensionFrontend({ ...CREATURE_FRONTEND_METADATA, plugin: creatureVideoAssetsExtension });

import { createRoot } from "react-dom/client";
import "@woohaa3/photocraft-editor/ui/styles.css";
import "@woohaa3/photocraft-editor/ui/forms.css";
import "@woohaa3/photocraft-editor/styles.css";
import "./dev.css";
import { PhotoCraftDevApp } from "./PhotoCraftDevApp.js";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 #root 挂载点");
createRoot(root).render(<PhotoCraftDevApp />);

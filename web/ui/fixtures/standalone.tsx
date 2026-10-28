import { createRoot } from "react-dom/client";
import { Button, UiProvider } from "@woohaa3/ui/primitives";
import { TextInput } from "@woohaa3/ui/forms";
import { SettingsSection } from "@woohaa3/ui/settings";
import "@woohaa3/ui/styles.css";
const host = document.createElement("div");
document.body.append(host);
createRoot(host).render(<UiProvider><SettingsSection title="独立 UI 消费"><TextInput defaultValue="独立表单" /><Button onClick={event => { event.currentTarget.textContent = "已点击"; }}>确定</Button></SettingsSection></UiProvider>);

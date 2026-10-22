/**
 * Extension SDK `ui` 能力分组（宿主 adapter）
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 2.2 / design D2）。
 *
 * 只做静态具名 adapter：从公共 UI 叶子模块逐个取具名导出，禁止对整个 UI/Lucide barrel 做
 * namespace 展开，以免保留所有未用代码。分组费用纳入首屏预算审计。
 */
import {
  SettingsSection,
  SettingsFeedback,
} from "../../shared/ui/SettingsSection.js";
import {
  TextInput,
  TextArea,
  SelectInput,
} from "../../shared/ui/FormControls.js";
import { Button, IconButton } from "../../shared/ui/Button.js";
import { ServiceLogo } from "../../shared/ui/ServiceLogo.js";
import { Tooltip } from "../../shared/ui/Tooltip.js";
import { Popover } from "../../shared/ui/Popover.js";
import { UiPortalScope } from "../../shared/ui/UiProvider.js";
import { DropdownMenu, DropdownMenuItem } from "../../shared/ui/Menu.js";
import { Listbox } from "../../shared/ui/Listbox.js";
import { Tabs } from "../../shared/ui/Tabs.js";
import { SegmentedControl } from "../../shared/ui/SegmentedControl.js";
import {
  Collapsible,
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../shared/ui/Collapsible.js";
import { ScrollArea } from "../../shared/ui/ScrollArea.js";
import {
  CloseIcon,
  ChevronDownIcon,
  DiamondIcon,
  EllipsisIcon,
  FilmIcon,
  ImageIcon,
  LayoutGridIcon,
  MenuListIcon,
  PlusIcon,
  SnippetLibraryIcon,
  TrashIcon,
  VideoIcon,
  CheckIcon,
  CopyIcon,
  LocateIcon,
  RefreshIcon,
  SendIcon,
} from "../../shared/ui/icons.js";
import { objectPayload } from "../services/dialogs/registry.js";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../services/dialogs/Dialog.js";
import { AlertDialog } from "../services/dialogs/AlertDialog.js";
import type { ExtensionSdkGroupModule } from "./sdk-groups.js";

export const group = "ui" as const;

export const namedExports = {
  Button,
  ServiceLogo,
  TextInput,
  TextArea,
  SelectInput,
  Collapsible,
  SettingsSection,
  SettingsFeedback,
  IconButton,
  Tooltip,
  Popover,
  UiPortalScope,
  DropdownMenu,
  DropdownMenuItem,
  Listbox,
  Tabs,
  SegmentedControl,
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
  ScrollArea,
  objectPayload,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  AlertDialog,
  CloseIcon,
  ChevronDownIcon,
  DiamondIcon,
  EllipsisIcon,
  FilmIcon,
  ImageIcon,
  LayoutGridIcon,
  MenuListIcon,
  PlusIcon,
  SnippetLibraryIcon,
  TrashIcon,
  VideoIcon,
  CheckIcon,
  CopyIcon,
  LocateIcon,
  RefreshIcon,
  SendIcon,
} satisfies Record<string, unknown>;

const module: ExtensionSdkGroupModule = { group, namedExports };
export default module;

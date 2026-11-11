import { bashTool, ToolRegistry } from "./toolkit/index.ts";
import { DescriptorRegistry, type DescriptorChild, ListDescriptor, CliShimDescriptor, BinFolderDescriptor } from "./vfs/index.ts";

/**
 * The harness's wiring manifest: the set of model-facing tools and the set of
 * virtual filesystem descriptors are declared here, as module-level constants,
 * and the registries are derived from them. `index.ts` then stays a thin CLI
 * shell — it never mixes tool/descriptor construction with startup.
 */

/** Model-facing harness tools. */
export const AVAILABLE_TOOLS = [bashTool];

/**
 * Virtual filesystem descriptors, keyed by mount path.
 * Now includes a `bin` folder descriptor and the `bin/yog` CLI shim.
 */
export const AVAILABLE_DESCRIPTORS: Record<string, DescriptorChild> = {
  "/bin": new BinFolderDescriptor(),
  "/bin/yog": new CliShimDescriptor(),
  "/list": new ListDescriptor(),
};

/** Registry of harness tools (keyed by tool name). */
export const tools = new ToolRegistry(AVAILABLE_TOOLS);

/** Registry of FUSE descriptors (keyed by mount path). */
export const descriptors = new DescriptorRegistry(Object.entries(AVAILABLE_DESCRIPTORS));
